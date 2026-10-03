import type { Room } from "colyseus.js";
import { CHAT_RADIUS } from "@klase/shared";

type VoiceMsg = { from: string; type: string; payload?: RTCSessionDescriptionInit | RTCIceCandidateInit };
type Pos = { x: number; z: number };

/**
 * ICE servers. STUN alone fails for people behind strict NATs (school Wi-Fi, mobile data,
 * carrier-grade NAT), which shows up as "sometimes I can hear them, sometimes not".
 * Add a TURN relay via env to make those cases work:
 *   VITE_TURN_URL=turn:your.turn.host:3478,turns:your.turn.host:443?transport=tcp
 *   VITE_TURN_USERNAME=...   VITE_TURN_CREDENTIAL=...
 */
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
  ];
  const turn = String(import.meta.env.VITE_TURN_URL ?? "").trim();
  if (turn) {
    servers.push({
      urls: turn.split(",").map((s) => s.trim()).filter(Boolean),
      username: String(import.meta.env.VITE_TURN_USERNAME ?? "").trim(),
      credential: String(import.meta.env.VITE_TURN_CREDENTIAL ?? "").trim(),
    });
  }
  return servers;
}
const RTC_CONFIG: RTCConfiguration = { iceServers: buildIceServers() };

/** Stop sending / hearing only once someone is clearly out of range (prevents edge flapping). */
const DROP_RADIUS = CHAT_RADIUS + 0.8;
/** How long a peer may be missing from the world before we tear its connection down. */
const GONE_GRACE_MS = 2500;

type Peer = {
  id: string;
  pc: RTCPeerConnection;
  tr: RTCRtpTransceiver | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  chain: Promise<void>;
  // receive side
  audio: HTMLAudioElement; // kept (muted) so Chrome actually pumps remote audio into WebAudio
  srcNode: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  vol: number;
  // send side
  near: boolean;
  sendBusy: boolean;
  lastSeen: number;
  disconnectTimer: number;
};

export class VoiceMesh {
  private peers = new Map<string, Peer>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserSrc: MediaStreamAudioSourceNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private lastSentLevel = -1;
  private lastSentAt = 0;
  private lastKick = 0;
  private micWanted = false;
  private micBusy = false;
  private disposed = false;

  localLevel = 0;
  micOn = false;
  muteAll = false;
  localMuted = new Set<string>();
  serverMutedIds = new Set<string>();
  /** Fired when the OS/browser kills the mic (device unplugged, permission revoked). */
  onMicEnded: (() => void) | null = null;

  private gesture = () => {
    if (this.ctx && this.ctx.state === "running") return;
    void this.unlock();
  };

  constructor(
    private room: Room,
    private selfId: string,
  ) {
    this.room.onMessage("voice", (msg: VoiceMsg) => this.onSignal(msg));
    // Browsers block audio until a user gesture. Listen for ANY gesture (keyboard too, since players
    // walk with WASD and may never click the canvas) for the whole session, not just the first canvas click.
    for (const ev of ["pointerdown", "keydown", "touchend", "click"]) {
      window.addEventListener(ev, this.gesture, { passive: true });
    }
  }

  /* ───────────────────────── audio context / autoplay ───────────────────────── */

  private audioCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  async unlock() {
    try {
      const ctx = this.audioCtx();
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      /* needs a gesture; we retry on the next one */
    }
    for (const p of this.peers.values()) void p.audio.play().catch(() => { });
  }

  /** Called every frame; cheaply retries if the context got suspended (tab switch, iOS interruption). */
  private kickAudio(now: number) {
    if (!this.ctx || this.ctx.state === "running" || now - this.lastKick < 1500) return;
    this.lastKick = now;
    void this.ctx.resume().catch(() => { });
  }

  /* ───────────────────────── microphone ───────────────────────── */

  async setMic(on: boolean) {
    this.micWanted = on;
    if (this.micBusy) return;
    this.micBusy = true;
    try {
      await this.unlock();
      while (this.micOn !== this.micWanted) {
        await this.applyMic(this.micWanted);
      }
    } catch (err) {
      this.micWanted = false;
      this.stopMic();
      throw err;
    } finally {
      this.micBusy = false;
    }
  }

  private liveTrack() {
    return this.stream?.getAudioTracks().find((t) => t.readyState === "live") ?? null;
  }

  private async applyMic(on: boolean) {
    if (!on) {
      this.stopMic();
      return;
    }
    if (!this.liveTrack()) {
      this.stream?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!this.micWanted || this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      for (const t of stream.getAudioTracks()) {
        t.onended = () => {
          if (this.stream !== stream) return;
          this.micWanted = false;
          this.stopMic();
          this.onMicEnded?.();
        };
      }
      this.hookAnalyser();
    }
    this.micOn = true;
  }

  /** Fully release the mic (browser recording indicator goes off). Peers stop sending on the next tick. */
  private stopMic() {
    this.micOn = false;
    this.localLevel = 0;
    this.unhookAnalyser();
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = null;
    this.pushLevel(0, true);
  }

  setServerMuted(ids: Iterable<string>) {
    this.serverMutedIds = new Set(ids);
  }

  /* ───────────────────────── per-frame proximity logic ───────────────────────── */

  /**
   * Every player in the room gets ONE long-lived connection (max 12 players, so this is cheap).
   * Distance only decides (a) whether we send our mic to them and (b) how loud they are for us.
   * Connections are never torn down because someone walked away, which is what caused the
   * constant renegotiation / "sometimes I can't hear them" before.
   */
  tick(positions: Map<string, Pos>, selfMuted: boolean) {
    const now = performance.now();
    this.kickAudio(now);
    this.localLevel = this.readLevel(selfMuted);
    this.pushLevel(this.localLevel, false);

    const me = positions.get(this.selfId);
    if (!me) return;

    const sendTrack = this.micOn && !selfMuted ? this.liveTrack() : null;

    for (const [id, pos] of positions) {
      if (id === this.selfId) continue;
      let peer = this.peers.get(id);
      if (peer && peer.pc.signalingState === "closed") {
        this.drop(id);
        peer = undefined;
      }
      // Deterministic initiator (lower id calls). The other side just answers, so there is no glare.
      if (!peer && this.selfId < id) peer = this.createPeer(id, true);
      if (!peer) continue;
      peer.lastSeen = now;

      const d = Math.hypot(me.x - pos.x, me.z - pos.z);
      peer.near = d <= CHAT_RADIUS || (peer.near && d <= DROP_RADIUS);

      // Receive: loudness by distance.
      const silenced = this.muteAll || this.localMuted.has(id) || this.serverMutedIds.has(id) || !peer.near;
      this.setVolume(peer, silenced ? 0 : Math.max(0, 1 - d / CHAT_RADIUS));

      // Send: our mic goes to everyone in range, and only to them.
      this.syncSend(peer, peer.near ? sendTrack : null);
    }

    for (const peer of [...this.peers.values()]) {
      if (!positions.has(peer.id) && now - peer.lastSeen > GONE_GRACE_MS) this.drop(peer.id);
    }
  }

  private setVolume(peer: Peer, vol: number) {
    peer.vol = vol;
    if (peer.gain && this.ctx) {
      peer.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
    } else {
      // Fallback path when WebAudio isn't available.
      peer.audio.muted = vol === 0;
      peer.audio.volume = vol;
    }
  }

  /** Swap the track on this peer's sender. replaceTrack never triggers renegotiation. */
  private syncSend(peer: Peer, track: MediaStreamTrack | null) {
    const tr = peer.tr;
    if (!tr || peer.sendBusy || tr.sender.track === track) return;
    peer.sendBusy = true;
    tr.sender
      .replaceTrack(track)
      .catch(() => { })
      .finally(() => {
        peer.sendBusy = false;
      });
  }

  /* ───────────────────────── peers & signaling ───────────────────────── */

  private createPeer(id: string, initiate: boolean): Peer {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = true; // sound goes through WebAudio (works on iOS, where element.volume is ignored)
    audio.setAttribute("playsinline", "");

    const peer: Peer = {
      id,
      pc,
      tr: null,
      polite: this.selfId > id,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      chain: Promise.resolve(),
      audio,
      srcNode: null,
      gain: null,
      vol: 0,
      near: false,
      sendBusy: false,
      lastSeen: performance.now(),
      disconnectTimer: 0,
    };
    this.peers.set(id, peer);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.send(id, "ice", ev.candidate.toJSON());
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        const d = pc.localDescription;
        if (d) this.send(id, "offer", { type: d.type, sdp: d.sdp });
      } catch {
        /* closed / glare: perfect-negotiation handles the retry */
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      peer.audio.srcObject = stream;
      void peer.audio.play().catch(() => { });
      try {
        const ctx = this.audioCtx();
        peer.srcNode?.disconnect();
        peer.gain?.disconnect();
        peer.srcNode = ctx.createMediaStreamSource(stream);
        peer.gain = ctx.createGain();
        peer.gain.gain.value = peer.vol;
        peer.srcNode.connect(peer.gain).connect(ctx.destination);
        peer.audio.muted = true;
      } catch {
        peer.srcNode = null;
        peer.gain = null;
        peer.audio.muted = peer.vol === 0;
        peer.audio.volume = peer.vol;
      }
    };

    // Self-heal dead connections instead of staying silent until the player rejoins.
    pc.onconnectionstatechange = () => {
      window.clearTimeout(peer.disconnectTimer);
      if (pc.connectionState === "failed") {
        pc.restartIce();
      } else if (pc.connectionState === "disconnected") {
        peer.disconnectTimer = window.setTimeout(() => {
          if (pc.connectionState === "disconnected") pc.restartIce();
        }, 4000);
      }
    };

    // Both directions are negotiated up-front (sendrecv, track attached later), so toggling the
    // mic never needs a renegotiation.
    if (initiate) peer.tr = pc.addTransceiver("audio", { direction: "sendrecv" });
    return peer;
  }

  private send(to: string, type: string, payload?: unknown) {
    if (this.disposed) return;
    this.room.send("voice", { to, type, payload });
  }

  private onSignal(msg: VoiceMsg) {
    if (this.disposed || !msg?.from || msg.from === this.selfId) return;
    let peer = this.peers.get(msg.from);
    if (peer && peer.pc.signalingState === "closed") {
      this.drop(msg.from);
      peer = undefined;
    }
    if (!peer) {
      if (msg.type !== "offer") return; // stale answer/ICE for a connection we no longer have
      peer = this.createPeer(msg.from, false);
    }
    const p = peer;
    // Handle one message at a time per peer so awaits can't interleave (this used to drop ICE candidates).
    p.chain = p.chain.then(() => this.handleSignal(p, msg)).catch((e) => console.warn("[voice]", e));
  }

  private async handleSignal(peer: Peer, msg: VoiceMsg) {
    const { pc } = peer;
    if (pc.signalingState === "closed") return;

    if (msg.type === "offer" && msg.payload) {
      const collision = peer.makingOffer || pc.signalingState !== "stable";
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      await this.flushIce(peer);
      const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === "audio") ?? null;
      if (tr) {
        peer.tr = tr;
        tr.direction = "sendrecv";
      }
      await pc.setLocalDescription();
      const d = pc.localDescription;
      if (d) this.send(peer.id, "answer", { type: d.type, sdp: d.sdp });
    } else if (msg.type === "answer" && msg.payload) {
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        await this.flushIce(peer);
      }
    } else if (msg.type === "ice" && msg.payload) {
      const cand = msg.payload as RTCIceCandidateInit;
      if (!pc.remoteDescription) {
        peer.pendingIce.push(cand); // arrived before the offer/answer was applied: keep it
        return;
      }
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {
        if (!peer.ignoreOffer) console.warn("[voice] addIceCandidate", e);
      }
    }
  }

  private async flushIce(peer: Peer) {
    const queued = peer.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch {
        /* candidate for a superseded negotiation */
      }
    }
  }

  private drop(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    window.clearTimeout(peer.disconnectTimer);
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.srcNode?.disconnect();
      peer.gain?.disconnect();
    } catch {
      /* ignore */
    }
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
  }

  dispose() {
    this.disposed = true;
    for (const ev of ["pointerdown", "keydown", "touchend", "click"]) {
      window.removeEventListener(ev, this.gesture);
    }
    this.stopMic();
    for (const id of [...this.peers.keys()]) this.drop(id);
    void this.ctx?.close().catch(() => { });
    this.ctx = null;
  }

  /* ───────────────────────── local level meter ───────────────────────── */

  private hookAnalyser() {
    this.unhookAnalyser();
    if (!this.stream) return;
    const ctx = this.audioCtx();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.35;
    this.analyserSrc = ctx.createMediaStreamSource(this.stream);
    this.analyserSrc.connect(this.analyser);
    this.levelBuf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
  }

  private unhookAnalyser() {
    try {
      this.analyserSrc?.disconnect();
    } catch {
      /* ignore */
    }
    this.analyserSrc = null;
    this.analyser = null;
    this.levelBuf = null;
  }

  private readLevel(selfMuted: boolean) {
    if (!this.micOn || selfMuted || !this.analyser || !this.levelBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = this.levelBuf[i]!;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.levelBuf.length);
    return Math.min(1, Math.max(0, (rms - 0.018) / 0.22));
  }

  private pushLevel(level: number, force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastSentAt < 100) return;
    const crossed = (level >= 0.08) !== (this.lastSentLevel >= 0.08);
    if (!force && !crossed && Math.abs(level - this.lastSentLevel) < 0.05) return;
    this.lastSentAt = now;
    this.lastSentLevel = level;
    if (!this.disposed) this.room.send("voice-level", { level });
  }
}