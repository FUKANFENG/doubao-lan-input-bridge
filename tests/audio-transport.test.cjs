const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const WebSocket = require("ws");
const { AudioTransport } = require("../electron/audio-transport.cjs");
const { decodePacket } = require("../electron/audio-player.js");

const chunk = (capturedAt = 0) => ({ pcm: new Int16Array(2048).buffer, capturedAt, sentAt: Date.now(), deliveryMs: 0 });
async function fixture(t) {
  const server = http.createServer();
  const transport = new AudioTransport({ getKey: () => "test-key" });
  transport.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { transport.close(); await new Promise(resolve => server.close(resolve)); });
  return { transport, url: `ws://127.0.0.1:${server.address().port}/audio` };
}

test("real WebSocket authenticates, streams framed PCM and responds to heartbeat", { timeout: 5000 }, async t => {
  const { transport, url } = await fixture(t);
  transport.setCapture({ capturing: true, sampleRate: 48000 });
  const ws = new WebSocket(url + "?key=test-key&protocol=2");
  const initial = once(ws, "message");
  await once(ws, "open");
  assert.equal(JSON.parse((await initial)[0]).protocol, 2);
  const frame = once(ws, "message");
  transport.push(chunk());
  const data = (await frame)[0];
  const decoded = decodePacket(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  assert.equal(decoded.samples.length, 2048);
  assert.equal(decoded.sampleRate, 48000);
  const pong = once(ws, "message");
  ws.send('{"type":"ping"}');
  assert.equal(JSON.parse((await pong)[0]).type, "pong");
  ws.terminate();
});

test("invalid access keys are rejected before upgrade", { timeout: 5000 }, async t => {
  const { url } = await fixture(t);
  const ws = new WebSocket(url + "?key=wrong");
  const [error] = await once(ws, "error");
  assert.match(error.message, /401/);
});

test("older phone clients still receive raw PCM", { timeout: 5000 }, async t => {
  const { transport, url } = await fixture(t);
  transport.setCapture({ capturing: true, sampleRate: 44100 });
  const ws = new WebSocket(url + "?key=test-key");
  const initial = once(ws, "message");
  await once(ws, "open"); await initial;
  const frame = once(ws, "message");
  transport.push(chunk());
  assert.equal((await frame)[0].length, 4096);
  ws.terminate();
});

test("slow client is terminated without preventing delivery to healthy clients", () => {
  const transport = new AudioTransport({ getKey: () => "key" });
  transport.setCapture({ capturing: true, sampleRate: 48000 });
  const slow = { readyState: WebSocket.OPEN, audioProtocol: 2, bufferedAmount: 100000,
    terminate() { this.closed = true; }, send() { throw new Error("must not enqueue"); } };
  const healthy = { readyState: WebSocket.OPEN, audioProtocol: 2, bufferedAmount: 0, send(packet) { this.packet = packet; } };
  transport.clients.add(slow); transport.clients.add(healthy);
  transport.push(chunk());
  assert.equal(slow.closed, true);
  assert.equal(healthy.packet.length, 4120);
  assert.equal(transport.state.slowDisconnects, 1);
});

test("stale capture is discarded and produces a sequence discontinuity", () => {
  const transport = new AudioTransport({ getKey: () => "key" });
  transport.setCapture({ capturing: true, sampleRate: 48000 });
  const packets = [];
  transport.clients.add({ readyState: 1, bufferedAmount: 0, audioProtocol: 2, send(p) { packets.push(p); } });
  transport.push(chunk());
  transport.push({ ...chunk(2048 / 48000), deliveryMs: 500 });
  transport.push(chunk(4096 / 48000));
  assert.equal(transport.state.lateChunks, 1);
  assert.equal(packets.length, 2);
  assert.ok(packets[1].readUInt32LE(4) > packets[0].readUInt32LE(4) + 1);
});

test("capture restart creates a fresh session and resets metrics", () => {
  const transport = new AudioTransport({ getKey: () => "key" });
  transport.setCapture({ capturing: true, sampleRate: 48000 });
  const session = transport.state.sessionId;
  transport.push(chunk());
  transport.setCapture({ capturing: false });
  transport.push(chunk());
  assert.equal(transport.state.framesReceived, 1);
  transport.setCapture({ capturing: true, sampleRate: 44100 });
  assert.notEqual(transport.state.sessionId, session);
  assert.equal(transport.state.framesReceived, 0);
});
