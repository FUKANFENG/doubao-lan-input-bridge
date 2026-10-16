const test = require("node:test");
const assert = require("node:assert/strict");
const { PcmPlayer, decodePacket, MAGIC, HEADER_BYTES } = require("../electron/audio-player.js");

function fakeContext() {
  return { currentTime: 0, state: "running", destination: {}, spans: [],
    createBuffer(_channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; },
    createBufferSource() {
      const context = this;
      return { connect() {}, disconnect() {}, stop() { this.stopped = true; },
        start(at) { this.startAt = at; this.endAt = at + this.buffer.duration; context.spans.push(this); } };
    },
    advance(time) {
      this.currentTime = time;
      for (const source of this.spans) if (source.endAt <= time && source.onended) { source.onended(); source.onended = null; }
    }
  };
}
const packet = (sequence, sampleRate = 48000) => ({ sequence, sampleRate, capturedAt: sequence * 2048 / sampleRate, samples: new Int16Array(2048) });

test("player buffers actual audio before starting; default target is 300 ms", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  for (let i = 0; i < 7; i++) player.enqueue(packet(i));
  assert.equal(ctx.spans.length, 0);
  player.enqueue(packet(7));
  assert.equal(ctx.spans.length, 8);
  assert.equal(player.snapshot().buffering, false);
});

test("steady stream and bounded arrival jitter play continuously without overlap", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  let lastArrival = 0;
  for (let i = 0; i < 300; i++) {
    const arrival = Math.max(lastArrival, i * 2048 / 48000 + (i % 11 === 0 ? 0.1 : 0));
    ctx.advance(arrival);
    player.enqueue(packet(i));
    lastArrival = arrival;
  }
  assert.equal(player.stats.underruns, 0);
  assert.equal(player.stats.overruns, 0);
  for (let i = 1; i < ctx.spans.length; i++) assert.ok(Math.abs(ctx.spans[i].startAt - ctx.spans[i - 1].endAt) < 1e-8);
});

test("delivery burst cancels old sources before rescheduling and bounds the queue", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  for (let i = 0; i < 100; i++) player.enqueue(packet(i));
  assert.ok(player.stats.overruns > 0);
  assert.ok(player.snapshot().queuedMs <= 700);
  const live = ctx.spans.filter(source => !source.stopped);
  for (let i = 1; i < live.length; i++) assert.ok(live[i].startAt >= live[i - 1].endAt);
});

test("underrun is counted once and re-buffers at a larger target", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  for (let i = 0; i < 8; i++) player.enqueue(packet(i));
  ctx.advance(2);
  player.tick();
  player.tick();
  assert.equal(player.stats.underruns, 1);
  assert.equal(player.targetMs, 350);
  player.enqueue(packet(8));
  assert.equal(player.playing, false);
  for (let i = 9; i < 17; i++) player.enqueue(packet(i));
  assert.equal(player.playing, true);
});

test("stop/reset immediately cancels already scheduled audio", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  for (let i = 0; i < 8; i++) player.enqueue(packet(i));
  player.reset();
  assert.ok(ctx.spans.every(source => source.stopped));
  assert.equal(player.sources.size, 0);
  assert.equal(player.snapshot().queuedMs, 0);
});

test("sample rate changes and sequence gaps cannot mix old and new timelines", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  for (let i = 0; i < 8; i++) player.enqueue(packet(i));
  player.enqueue(packet(20));
  assert.equal(player.stats.sequenceGaps, 1);
  assert.ok(ctx.spans.every(source => source.stopped));
  player.enqueue(packet(21, 44100));
  assert.equal(player.sampleRate, 44100);
  assert.equal(player.pending.length, 1);
});

test("suspended browser ignores incoming audio; explicit resume starts fresh", () => {
  const ctx = fakeContext(), player = new PcmPlayer(ctx);
  ctx.state = "suspended";
  for (let i = 0; i < 1000; i++) player.enqueue(packet(i));
  assert.equal(player.pending.length, 0);
  ctx.state = "running";
  player.reset();
  player.enqueue(packet(1000));
  assert.equal(player.stats.sequenceGaps, 0);
});

test("buffer controls are bounded; adjustments cancel old audio", () => {
  const player = new PcmPlayer(fakeContext(), "bad");
  assert.equal(player.baseMs, 300);
  player.setBufferMs(10000);
  assert.equal(player.targetMs, 600);
  player.setBufferMs(0);
  assert.equal(player.targetMs, 200);
});

test("binary decoder checks header, sample rate, length and zero-copy PCM", () => {
  const buf = new ArrayBuffer(HEADER_BYTES + 4), view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 42, true);
  view.setUint32(8, 48000, true);
  view.setUint32(12, 2, true);
  view.setInt16(24, -32768, true);
  const decoded = decodePacket(buf);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.samples[0], -32768);
  assert.equal(decodePacket(buf.slice(0, 25)), null);
  view.setUint32(8, 0, true);
  assert.equal(decodePacket(buf), null);
});
