const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function fixture() {
  const packets = [];
  const context = { currentFrame: 0, sampleRate: 48000, Int16Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => packets.push(data) }; } },
    registerProcessor(_name, ctor) { this.Processor = ctor; } };
  context.registerProcessor = (_name, ctor) => { context.Processor = ctor; };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/audio-capture-worklet.js"), "utf8"), context);
  const processor = new context.Processor();
  return { packets, processor, render(blockSize, blocks, a = 1, b = -1) {
    for (let i = 0; i < blocks; i++) {
      processor.process([[new Float32Array(blockSize).fill(a), new Float32Array(blockSize).fill(b)]]);
      context.currentFrame += blockSize;
    }
  } };
}

test("worklet mixes channels and batches variable render quanta into PCM", () => {
  const f = fixture();
  f.render(128, 8); f.render(256, 4);
  assert.equal(f.packets.length, 1);
  assert.equal(f.packets[0].pcm.byteLength, 4096);
  assert.ok(new Int16Array(f.packets[0].pcm).every(x => x === 0));
  assert.equal(f.packets[0].capturedAt, 0);
});

test("worklet caps in-flight messages until main process acknowledges them", () => {
  const f = fixture();
  f.render(128, 16 * 100);
  assert.equal(f.packets.length, 8);
  assert.equal(f.processor.dropped, 92);
  f.processor.port.onmessage({ data: "ack" });
  f.render(128, 16);
  assert.equal(f.packets.length, 9);
  assert.equal(f.packets[8].dropped, 92);
});

test("worklet clamps loud input to valid signed 16-bit PCM", () => {
  const f = fixture();
  f.render(128, 16, 10, 10);
  assert.equal(new Int16Array(f.packets[0].pcm)[0], 32767);
  f.render(128, 16, -10, -10);
  assert.equal(new Int16Array(f.packets[1].pcm)[0], -32768);
});
