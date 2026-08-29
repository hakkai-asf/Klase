import type { Room } from "colyseus.js";
import { CHAT_RADIUS } from "@klase/shared";

type VoiceMsg = { from: string; type: string; payload?: RTCSessionDescriptionInit | RTCIceCandidateInit };
type Pos = { x: number; z: number };

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const DROP_RADIUS = CHAT_RADIUS + 0.8;

type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  polite: boolean;
};

export class VoiceMesh {
  private peers = new Map<string, Peer>();
  private ensuring = new Set<string>();
  private stream: MediaStream | null = null;
  private makingOffer = new Set<string>();
  private ctx: AudioContext | null = null;
  micOn = false;
  localMuted = new Set<string>();
  serverMutedIds = new Set<string>();

  constructor(
    private room: Room,
    private selfId: string,
  ) {
    this.room.onMessage("voice", (msg: VoiceMsg) => void this.onSignal(msg));
  }

  async unlock() {
    const ctx = this.audioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    for (const peer of this.peers.values()) {
      void peer.audio.play().catch(() => {});
    }
  }

  async setMic(on: boolean) {
    await this.unlock();
    if (on) {
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      this.micOn = true;
      await this.syncSenders();
    } else {
      this.micOn = false;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      await this.syncSenders();
    }
  }

  setServerMuted(ids: Iterable<string>) {
    this.serverMutedIds = new Set(ids);
  }

  tick(positions: Map<string, Pos>, selfMuted: boolean) {
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) t.enabled = this.micOn && !selfMuted;
    }
    const me = positions.get(this.selfId);
    if (!me) return;
    const nearby = new Set<string>();
    for (const [id, pos] of positions) {
      if (id === this.selfId) continue;
      const d = Math.hypot(me.x - pos.x, me.z - pos.z);
      const keep = this.peers.has(id) && d <= DROP_RADIUS;
      if (d > CHAT_RADIUS && !keep) continue;
      nearby.add(id);
      void this.ensure(id);
      const peer = this.peers.get(id);
      if (!peer) continue;
      const silenced = this.localMuted.has(id) || this.serverMutedIds.has(id);
      peer.audio.volume = silenced ? 0 : Math.max(0, 1 - d / CHAT_RADIUS);
      peer.audio.muted = silenced;
    }
    for (const id of [...this.peers.keys()]) {
      if (!nearby.has(id)) this.close(id, true);
    }
  }

  dispose() {
    this.micOn = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    for (const id of [...this.peers.keys()]) this.close(id, true);
    void this.ctx?.close();
    this.ctx = null;
  }

  private audioCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private async syncSenders() {
    const track = this.stream?.getAudioTracks()[0] ?? null;
    for (const peer of this.peers.values()) {
      const tr = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio" || t.sender.track?.kind === "audio")
        ?? peer.pc.getTransceivers()[0];
      if (!tr) continue;
      tr.direction = track ? "sendrecv" : "recvonly";
      try {
        await tr.sender.replaceTrack(track);
      } catch {
        /* ignore */
      }
    }
  }

  private async ensure(id: string) {
    if (this.peers.has(id) || this.ensuring.has(id)) return;
    this.ensuring.add(id);
    try {
      if (this.peers.has(id)) return;
      const polite = this.selfId < id;
      const pc = new RTCPeerConnection(ICE);
      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      audio.volume = 0;

      const peer: Peer = { pc, audio, polite };
      this.peers.set(id, peer);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.room.send("voice", { to: id, type: "ice", payload: ev.candidate.toJSON() });
        }
      };
      pc.onnegotiationneeded = () => {
        void this.negotiate(id);
      };
      pc.ontrack = (ev) => {
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        audio.srcObject = stream;
        void audio.play().catch(() => {});
      };

      const tr = pc.addTransceiver("audio", { direction: this.stream ? "sendrecv" : "recvonly" });
      const track = this.stream?.getAudioTracks()[0];
      if (track) await tr.sender.replaceTrack(track);
    } finally {
      this.ensuring.delete(id);
    }
  }

  private async negotiate(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    const { pc } = peer;
    try {
      this.makingOffer.add(id);
      await pc.setLocalDescription(await pc.createOffer());
      this.room.send("voice", { to: id, type: "offer", payload: pc.localDescription });
    } catch {
      /* glare / closed */
    } finally {
      this.makingOffer.delete(id);
    }
  }

  private async onSignal(msg: VoiceMsg) {
    await this.ensure(msg.from);
    const peer = this.peers.get(msg.from);
    if (!peer) return;
    const { pc, polite } = peer;

    if (msg.type === "offer" && msg.payload) {
      const offerCollision = this.makingOffer.has(msg.from) || pc.signalingState !== "stable";
      if (offerCollision && !polite) return;
      await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      await pc.setLocalDescription(await pc.createAnswer());
      this.room.send("voice", { to: msg.from, type: "answer", payload: pc.localDescription });
    }
    if (msg.type === "answer" && msg.payload) {
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      }
    }
    if (msg.type === "ice" && msg.payload) {
      try {
        await pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
      } catch {
        /* ignore */
      }
    }
    if (msg.type === "bye") this.close(msg.from, false);
  }

  private close(id: string, notify: boolean) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (notify) this.room.send("voice", { to: id, type: "bye" });
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
  }
}
