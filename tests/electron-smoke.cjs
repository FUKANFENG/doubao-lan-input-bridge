const assert = require("node:assert/strict");
const path = require("node:path");
const { _electron, chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
(async () => {
  let desktopApp, browser;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    desktopApp = await _electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "electron-fixture.cjs")], env });
    const desktop = await desktopApp.firstWindow();
    const errors = [];
    desktop.on("pageerror", error => errors.push(error.message));
    await desktop.waitForFunction(() => Boolean(window.bridgeApi));
    await desktop.waitForFunction(async () => (await window.bridgeApi.getStatus()).running);
    const status = await desktop.evaluate(() => window.bridgeApi.getStatus());
    assert.ok(status.userData.includes("electron-profile-"), "never use user's normal profile");
    assert.ok(desktop.url().startsWith("file:"));
    await desktop.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const context = new AudioContext(), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        window.syntheticTone = context;
        return destination.stream;
      };
    });
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true, args: ["--mute-audio"] });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    phone.on("pageerror", error => errors.push(error.message));
    await phone.goto(status.urls.localUrl);
    await phone.locator("#audioStart").click();
    await desktop.getByRole("button", { name: "开始采集", exact: true }).click();
    await phone.waitForFunction(() => document.getElementById("audioTitle").textContent === "正在播放电脑声音");
    const audio = (await desktop.evaluate(() => window.bridgeApi.getStatus())).audio;
    assert.ok(audio.framesReceived > 5);
    await desktop.getByRole("button", { name: "停止采集", exact: true }).click();
    await phone.waitForFunction(() => document.getElementById("audioTitle").textContent === "等待电脑采集");
    await phone.locator("#audioStop").click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, fileProtocol: true, ipcFrames: audio.framesReceived,
      captureDeliveryMs: audio.captureDeliveryMs, checks: ["isolated Electron profile", "file:// renderer", "AudioWorklet blob module", "preload IPC", "HTTP assets", "WebSocket audio", "stop propagation"] }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (desktopApp) {
      const child = desktopApp.process();
      let timer;
      try {
        const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
          new Promise(resolve => child.once("exit", resolve));
        await Promise.race([desktopApp.close().catch(() => {}), exited,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Electron cleanup timed out")), 10000); })]);
      } finally { clearTimeout(timer); }
    }
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
