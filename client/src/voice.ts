import type { Room } from "colyseus.js";
import { CHAT_RADIUS } from "@klase/shared";

type VoiceMsg = { from: string; type: string; payload?: RTCSessionDescriptionInit | RTCIceCandidateInit };
type Pos = { x: number; z: number };

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export class VoiceMesh {
  private peers = new Map<
    string,
    { pc: RTCPeerConnection; gain: GainNode; ctx: AudioContext; polite: boolean }
  >();
  private stream: MediaStream | null = null;
  private makingOffer = new Set<string>();
  micOn = false;
  localMuted = new Set<string>();
  serverMutedIds = new Set<string>();

  constructor(
    private room: Room,
    private selfId: string,
  ) {
    this.room.onMessage("voice", (msg: VoiceMsg) => void this.onSignal(msg));
  }

  async setMic(on: boolean) {
    this.micOn = on;
    for (const id of [...this.peers.keys()]) this.close(id);
    if (on) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } else {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
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
      if (d > CHAT_RADIUS) continue;
      nearby.add(id);
      void this.ensure(id);
      const peer = this.peers.get(id);
      if (!peer) continue;
      const silenced = this.localMuted.has(id) || this.serverMutedIds.has(id);
      peer.gain.gain.value = silenced ? 0 : Math.max(0, 1 - d / CHAT_RADIUS);
    }
    for (const id of [...this.peers.keys()]) {
      if (!nearby.has(id)) this.close(id);
    }
  }

  dispose() {
    void this.setMic(false);
  }

  private async ensure(id: string) {
    if (this.peers.has(id)) return;
    const polite = this.selfId < id;
    const pc = new RTCPeerConnection(ICE);
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.room.send("voice", { to: id, type: "ice", payload: ev.candidate.toJSON() });
      }
    };
    pc.ontrack = (ev) => {
      const src = ctx.createMediaStreamSource(ev.streams[0]!);
      src.connect(gain);
    };
    if (this.stream) {
      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    this.peers.set(id, { pc, gain, ctx, polite });

    if (!polite) {
      this.makingOffer.add(id);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.room.send("voice", { to: id, type: "offer", payload: pc.localDescription });
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
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.room.send("voice", { to: msg.from, type: "answer", payload: pc.localDescription });
    }
    if (msg.type === "answer" && msg.payload) {
      await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
    }
    if (msg.type === "ice" && msg.payload) {
      try {
        await pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
      } catch {
        /* ignore */
      }
    }
    if (msg.type === "bye") this.close(msg.from);
  }

  private close(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.room.send("voice", { to: id, type: "bye" });
    peer.pc.close();
    void peer.ctx.close();
    this.peers.delete(id);
  }
}
