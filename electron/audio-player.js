(function (root) {
  "use strict";
  const MAGIC = 0x32425044;
  const HEADER_BYTES = 24;

  function decodePacket(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_BYTES) return null;
    const view = new DataView(data);
    const sampleRate = view.getUint32(8, true);
    const frames = view.getUint32(12, true);
    if (view.getUint32(0, true) !== MAGIC || sampleRate < 8000 || sampleRate > 192000 ||
        !frames || frames > 8192 || data.byteLength !== HEADER_BYTES + frames * 2) return null;
    return { sequence: view.getUint32(4, true), sampleRate, capturedAt: view.getFloat64(16, true),
      samples: new Int16Array(data, HEADER_BYTES) };
  }

  class PcmPlayer {
    constructor(context, bufferMs = 300) {
      this.context = context;
      this.sources = new Set();
      this.pending = [];
      this.pendingSeconds = 0;
      this.nextTime = 0;
      this.playing = false;
      this.stats = { underruns: 0, overruns: 0, sequenceGaps: 0 };
      this.lastSequence = null;
      this.sampleRate = null;
      this.setBufferMs(bufferMs);
    }

    setBufferMs(value) {
      const ms = Number(value);
      this.baseMs = Number.isFinite(ms) ? Math.max(200, Math.min(600, ms)) : 300;
      this.targetMs = this.baseMs;
      this.reset();
    }

    reset() {
      for (const source of this.sources) {
        source.onended = null;
        try { source.stop(); } catch { /* already stopped */ }
        source.disconnect();
      }
      this.sources.clear();
      this.pending = [];
      this.pendingSeconds = 0;
      this.nextTime = 0;
      this.playing = false;
      this.lastSequence = null;
      this.sampleRate = null;
    }

    enqueue(packet) {
      if (this.context.state !== "running") return;
      if (this.sampleRate && packet.sampleRate !== this.sampleRate) this.reset();
      if (this.lastSequence !== null && packet.sequence !== ((this.lastSequence + 1) >>> 0)) {
        this.stats.sequenceGaps++;
        this.reset();
      }
      this.lastSequence = packet.sequence;
      this.sampleRate = packet.sampleRate;
      const duration = packet.samples.length / packet.sampleRate;
      const ahead = Math.max(0, this.nextTime - this.context.currentTime);
      if (ahead + this.pendingSeconds + duration > this.targetMs / 1000 + 0.4) {
        // Cancel the old schedule before starting a new timeline. Never rewind a live one.
        this.stats.overruns++;
        this.reset();
        this.lastSequence = packet.sequence;
        this.sampleRate = packet.sampleRate;
      }
      this.pending.push(packet);
      this.pendingSeconds += duration;
      this.tick();
    }

    tick() {
      if (this.context.state !== "running") return;
      const now = this.context.currentTime;
      if (this.playing && this.nextTime < now + 0.005) {
        this.stats.underruns++;
        this.playing = false;
        this.targetMs = Math.min(600, this.targetMs + 50);
      }
      if (!this.playing) {
        if (this.pendingSeconds < this.targetMs / 1000) return;
        this.nextTime = Math.max(now + 0.025, this.nextTime);
        this.playing = true;
      }
      for (const packet of this.pending) {
        const buffer = this.context.createBuffer(1, packet.samples.length, packet.sampleRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < channel.length; i++) channel[i] = packet.samples[i] / 32768;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.sources.add(source);
        source.onended = () => { source.disconnect(); this.sources.delete(source); };
        source.start(this.nextTime);
        this.nextTime += buffer.duration;
      }
      this.pending = [];
      this.pendingSeconds = 0;
    }

    snapshot() {
      return { ...this.stats, targetMs: this.targetMs, buffering: !this.playing,
        queuedMs: Math.round((Math.max(0, this.nextTime - this.context.currentTime) + this.pendingSeconds) * 1000) };
    }
  }

  const api = { PcmPlayer, decodePacket, MAGIC, HEADER_BYTES };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BridgeAudio = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
