// Synthetic audio only: this test never captures system sound or invokes Windows paste.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { once } = require("node:events");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { AudioTransport } = require("../electron/audio-transport.cjs");
const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const sandbox = { settings: { key: "browser-test" }, APP_VERSION: "2.5.0" };
vm.createContext(sandbox);
vm.runInContext(main.slice(main.indexOf("function escapeHtml("), main.indexOf("function parseBody(")), sandbox);
const transport = new AudioTransport({ getKey: () => "browser-test" });
let pasted = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(sandbox.mobileHtml("test")); return; }
  if (url.pathname === "/health" || url.pathname === "/automation") {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, result: { bindings: [], foreground: { process: "test.exe" }, resolution: { mode: "windows" } } })); return;
  }
  if (url.pathname === "/send") {
    let body = "";
    for await (const part of req) body += part;
    pasted = JSON.parse(body);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, result: { chars: pasted.text.length, mode_used: "windows" } })); return;
  }
  let file;
  if (["/audio-player.js", "/mobile-audio.js"].includes(url.pathname)) file = path.join(root, "electron", url.pathname.slice(1));
  else if (url.pathname.startsWith("/desktop/")) {
    const candidate = path.resolve(root, "dist", url.pathname.slice(9));
    if (candidate.startsWith(path.join(root, "dist") + path.sep)) file = candidate;
  }
  if (!file || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  res.end(fs.readFileSync(file));
});
transport.attach(server);

(async () => {
  let browser, desktop, mobile;
  const errors = [];
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const status = () => ({ running: true, version: "2.5.0", port: server.address().port, key: "browser-test",
      urls: { primaryPhoneUrl: origin, localUrl: origin, phoneUrls: [origin] }, mode: "auto", logs: [], appBindings: [], audio: transport.status() });
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome", args: ["--mute-audio"] });
    desktop = await browser.newPage({ viewport: { width: 1120, height: 760 } });
    desktop.on("pageerror", error => errors.push(error.message));
    await desktop.exposeFunction("testStatus", status);
    await desktop.exposeFunction("testCaptureState", value => { transport.setCapture(value); return status(); });
    await desktop.exposeFunction("testChunk", chunk => { transport.push({ ...chunk, pcm: Buffer.from(chunk.pcm) }); });
    await desktop.addInitScript(() => {
      window.bridgeApi = { getStatus: () => window.testStatus(), onLog: () => () => {}, onAudioStatus: () => () => {},
        setAudioState: value => window.testCaptureState(value),
        sendAudioChunk: chunk => window.testChunk({ ...chunk, pcm: [...new Uint8Array(chunk.pcm)] }) };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
        gain.gain.value = 0.03;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume();
        window.testTone = context;
        return destination.stream;
      };
    });
    mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    mobile.on("pageerror", error => errors.push(error.message));
    await mobile.addInitScript(() => {
      window.audioSpans = [];
      const original = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        window.playbackContext = this;
        const node = original.call(this), start = node.start.bind(node), stop = node.stop.bind(node);
        const span = {};
        node.start = at => {
          Object.assign(span, { start: at, end: at + node.buffer.duration,
            peak: Math.max(...node.buffer.getChannelData(0).slice(0, 2048).map(Math.abs)) });
          window.audioSpans.push(span); start(at);
        };
        node.stop = () => { span.cancelled = true; stop(); };
        return node;
      };
    });
    await desktop.goto(origin + "/desktop/index.html");
    await mobile.goto(origin);
    await mobile.locator("#audioStart").click();
    await desktop.getByRole("button", { name: "开始采集", exact: true }).click();
    await mobile.waitForFunction(() => document.getElementById("audioTitle").textContent === "正在播放电脑声音");
    await mobile.waitForFunction(() => window.audioSpans.length > 30);
    const signal = await mobile.evaluate(() => ({ frames: audioSpans.length, peak: Math.max(...audioSpans.map(s => s.peak)) }));
    assert.ok(signal.peak > 0.01, "real worklet -> WebSocket -> AudioBuffer contains nonzero PCM");
    const live = await mobile.evaluate(() => audioSpans.filter(s => !s.cancelled));
    for (let i = 1; i < live.length; i++) assert.ok(live[i].start >= live[i - 1].end - 0.0001);
    const send = transport.send.bind(transport), held = [];
    const beforeStall = await mobile.evaluate(() => audioSpans.length);
    transport.send = (ws, data) => { if (Buffer.isBuffer(data)) held.push([ws, data]); else send(ws, data); };
    await new Promise(resolve => setTimeout(resolve, 180));
    transport.send = send;
    for (const [ws, data] of held) send(ws, data);
    await mobile.waitForFunction(count => audioSpans.length > count + 15, beforeStall);
    await mobile.waitForFunction(() => document.getElementById("audioDiagnostics").textContent.includes("播放断供 0 次"));
    await mobile.evaluate(() => playbackContext.suspend());
    await mobile.waitForFunction(() => document.getElementById("audioStart").textContent === "继续播放");
    await mobile.locator("#audioStart").click();
    await mobile.waitForFunction(() => document.getElementById("audioTitle").textContent === "正在播放电脑声音");
    for (const ws of transport.clients) ws.terminate();
    await mobile.waitForFunction(() => document.getElementById("audioDiagnostics").textContent.includes("重连 1 次"));
    await mobile.waitForFunction(() => document.getElementById("audioTitle").textContent === "正在播放电脑声音");
    await mobile.locator("#audioBuffer").evaluate(el => { el.value = "450"; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); });
    await mobile.locator("#text").fill("audio regression text");
    await mobile.locator("#send").click();
    assert.equal(pasted.text, "audio regression text");
    await mobile.locator(".audioDiagnostics summary").click();
    const output = path.join(root, "release", "verification-2.5.0");
    fs.mkdirSync(output, { recursive: true });
    for (const width of [320, 390, 768]) {
      await mobile.setViewportSize({ width, height: 844 });
      assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}`);
      await mobile.screenshot({ path: path.join(output, `mobile-${width}.png`), fullPage: true });
    }
    await desktop.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
    await mobile.locator("#audioStop").click();
    assert.equal(await mobile.locator("#audioTitle").textContent(), "电脑声音未连接");
    await mobile.waitForFunction(() => audioSpans.every(s => s.cancelled || s.end <= playbackContext.currentTime));
    await mobile.reload();
    assert.equal(await mobile.locator("#audioBuffer").inputValue(), "450");
    assert.equal(await mobile.locator("#audioTitle").textContent(), "电脑声音未连接");
    await desktop.getByRole("button", { name: "停止采集", exact: true }).click();
    assert.equal(transport.state.capturing, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, signal, captureFrames: transport.state.framesReceived,
      screenshots: output, checks: ["real AudioWorklet PCM", "WebSocket playback", "180 ms network stall", "browser suspend/resume", "reconnect", "buffer persistence", "text send", "320/390/768 layout", "desktop layout", "stop cleanup"] }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ errors, audio: transport.status(),
      mobile: mobile ? await mobile.locator(".audioPanel").innerText().catch(() => "unavailable") : null,
      desktop: desktop ? await desktop.locator(".audioPanel").innerText().catch(() => "unavailable") : null }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    transport.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
