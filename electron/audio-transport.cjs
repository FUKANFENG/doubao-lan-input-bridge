const crypto = require("node:crypto");
const WebSocket = require("ws");
const { MAGIC, HEADER_BYTES } = require("./audio-player.js");

class AudioTransport {
  constructor({ getKey, onStatus = () => {}, log = () => {}, heartbeatMs = 5000 }) {
    this.getKey = getKey;
    this.onStatus = onStatus;
    this.log = log;
    this.heartbeatMs = heartbeatMs;
    this.clients = new Set();
    this.state = { capturing: false, sampleRate: 48000, bytesSent: 0, startedAt: null,
      lastChunkAt: null, sessionId: crypto.randomUUID(), framesReceived: 0,
      captureGapMs: 0, maxCaptureGapMs: 0, captureDeliveryMs: 0, lateChunks: 0,
      workletDropped: 0, slowDisconnects: 0, lastCaptureTime: null };
    this.sequence = 0;
  }

  status() {
    const queues = [...this.clients].map(ws => ws.bufferedAmount);
    return { type: "audio-status", protocol: 2, ...this.state, clientCount: this.clients.size,
      sendQueueMs: Math.round(Math.max(0, ...queues) / (this.state.sampleRate * 2) * 1000) };
  }

  notify() {
    const status = this.status();
    for (const ws of this.clients) this.send(ws, JSON.stringify(status));
    this.onStatus(status);
  }

  setCapture(next) {
    const capturing = Boolean(next && next.capturing);
    if (capturing && !this.state.capturing) {
      Object.assign(this.state, { sessionId: crypto.randomUUID(), bytesSent: 0, framesReceived: 0,
        lastChunkAt: null, lastCaptureTime: null, captureGapMs: 0, maxCaptureGapMs: 0,
        captureDeliveryMs: 0, lateChunks: 0, workletDropped: 0, slowDisconnects: 0 });
      this.sequence = 0;
    }
    this.state.capturing = capturing;
    const rate = Number(next && next.sampleRate);
    if (Number.isFinite(rate) && rate >= 8000 && rate <= 192000) this.state.sampleRate = rate;
    this.state.startedAt = capturing ? this.state.startedAt || Date.now() : null;
    this.notify();
  }

  send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Once queued TCP data is stale, restart the connection instead of growing the queue.
    const limit = this.state.sampleRate * 2 * 0.5;
    if (ws.bufferedAmount + Buffer.byteLength(data) > limit) {
      this.state.slowDisconnects++;
      this.log("audio slow client disconnected (send queue > 500 ms)");
      ws.terminate();
      return;
    }
    ws.send(data, error => { if (error) ws.terminate(); });
  }

  push(chunk) {
    if (!this.state.capturing || !chunk || !chunk.pcm) return;
    const pcm = Buffer.isBuffer(chunk.pcm) ? chunk.pcm : ArrayBuffer.isView(chunk.pcm)
      ? Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength)
      : chunk.pcm instanceof ArrayBuffer ? Buffer.from(chunk.pcm) : null;
    if (!pcm || !pcm.length || pcm.length > 16384 || pcm.length % 2) return;
    const now = Date.now();
    const capturedAt = Number(chunk.capturedAt);
    if (!Number.isFinite(capturedAt)) return;
    const age = Math.max(0, Number(chunk.deliveryMs) || 0) + Math.max(0, now - (Number(chunk.sentAt) || now));
    this.state.captureDeliveryMs = Math.round(age);
    this.state.workletDropped = Math.max(this.state.workletDropped, Number(chunk.dropped) || 0);
    this.state.framesReceived++;
    let sequence = this.sequence++ >>> 0;
    if (age > 300) { this.state.lateChunks++; return; }
    const expectedMs = pcm.length / 2 / this.state.sampleRate * 1000;
    if (this.state.lastChunkAt !== null) {
      this.state.captureGapMs = Math.round(Math.max(0, now - this.state.lastChunkAt - expectedMs));
      this.state.maxCaptureGapMs = Math.max(this.state.maxCaptureGapMs, this.state.captureGapMs);
    }
    // Audio-time gaps reveal capture/renderer drops even if TCP itself lost no messages.
    if (this.state.lastCaptureTime !== null && capturedAt - this.state.lastCaptureTime > expectedMs / 1000 + 0.01) {
      sequence = this.sequence++ >>> 0;
    }
    this.state.lastCaptureTime = capturedAt;
    this.state.lastChunkAt = now;
    this.state.bytesSent += pcm.length;
    const packet = Buffer.allocUnsafe(HEADER_BYTES + pcm.length);
    packet.writeUInt32LE(MAGIC, 0);
    packet.writeUInt32LE(sequence, 4);
    packet.writeUInt32LE(this.state.sampleRate, 8);
    packet.writeUInt32LE(pcm.length / 2, 12);
    packet.writeDoubleLE(capturedAt, 16);
    pcm.copy(packet, HEADER_BYTES);
    for (const ws of this.clients) this.send(ws, ws.audioProtocol === 2 ? packet : pcm);
  }

  attach(server) {
    this.wss = new WebSocket.Server({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    this.upgrade = (req, socket, head) => {
      let parsed;
      try { parsed = new URL(req.url, "http://localhost"); } catch { socket.destroy(); return; }
      if (parsed.pathname !== "/audio") { socket.destroy(); return; }
      if (parsed.searchParams.get("key") !== this.getKey()) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        ws.audioProtocol = parsed.searchParams.get("protocol") === "2" ? 2 : 1;
        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });
        ws.on("error", () => ws.terminate());
        ws.on("message", (data, binary) => {
          if (binary) return;
          try { if (JSON.parse(data.toString()).type === "ping") this.send(ws, JSON.stringify({ type: "pong" })); } catch { /* ignore unknown control messages */ }
        });
        ws.on("close", () => {
          this.clients.delete(ws);
          this.log("audio client disconnected");
          this.onStatus(this.status());
        });
        this.clients.add(ws);
        this.log("audio client connected");
        this.send(ws, JSON.stringify(this.status()));
        this.onStatus(this.status());
      });
    };
    server.on("upgrade", this.upgrade);
    this.server = server;
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    }, this.heartbeatMs);
    this.statusTimer = setInterval(() => this.notify(), 1000);
    this.heartbeatTimer.unref();
    this.statusTimer.unref();
  }

  close() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.statusTimer);
    if (this.server) this.server.off("upgrade", this.upgrade);
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    if (this.wss) this.wss.close();
    this.wss = null;
    this.server = null;
  }
}

module.exports = { AudioTransport };
