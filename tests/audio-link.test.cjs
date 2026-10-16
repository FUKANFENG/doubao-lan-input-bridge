const test = require("node:test");
const assert = require("node:assert/strict");
const { AudioLink } = require("../electron/mobile-audio.js");

function fixture() {
  let clock = 0, next = 0;
  const timers = new Map(), sockets = [], states = [];
  const link = new AudioLink({ url: () => "ws://test/audio", onState: (...state) => states.push(state),
    onPacket() {}, onStatus() {}, now: () => clock,
    later(fn, delay) { timers.set(++next, { fn, at: clock + delay }); return next; },
    cancel(id) { timers.delete(id); },
    socketFactory() {
      const ws = { readyState: 0, close() { this.closed = true; }, send() {} };
      sockets.push(ws); return ws;
    }
  });
  return { link, sockets, states, timers, advance(ms) {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
  } };
}

test("disconnect retries automatically; stop cancels all pending reconnects", () => {
  const f = fixture();
  f.link.start();
  f.sockets[0].onerror();
  assert.equal(f.states.at(-1)[0], "reconnecting");
  f.advance(500);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].onclose();
  f.link.stop();
  f.advance(100000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.timers.size, 0);
});

test("old sockets cannot deliver stale packets or close the new connection", () => {
  const f = fixture();
  let count = 0;
  f.link.onPacket = () => count++;
  f.link.start();
  const oldMessage = f.sockets[0].onmessage, oldClose = f.sockets[0].onclose;
  f.link.connect();
  oldMessage({ data: new ArrayBuffer(1) });
  oldClose();
  assert.equal(count, 0);
  assert.equal(f.link.socket, f.sockets[1]);
  f.link.stop();
});

test("watchdog detects silent half-open sockets; retries have bounded backoff", () => {
  const f = fixture();
  f.link.start();
  f.advance(12000);
  assert.equal(f.link.reconnects, 1);
  for (let i = 0; i < 12; i++) { f.advance(8000); f.link.socket.onerror(); }
  assert.equal(f.states.at(-1)[1], 8000);
  f.link.stop();
});

test("successful audio resets backoff; status/pong keep the connection alive", () => {
  const f = fixture();
  f.link.start();
  f.sockets[0].onerror();
  f.advance(500);
  const ws = f.sockets[1];
  ws.onmessage({ data: new ArrayBuffer(1) });
  assert.equal(f.link.attempt, 0);
  f.advance(9000);
  ws.onmessage({ data: '{"type":"pong"}' });
  f.advance(9000);
  assert.equal(f.link.socket, ws);
  f.link.stop();
});
