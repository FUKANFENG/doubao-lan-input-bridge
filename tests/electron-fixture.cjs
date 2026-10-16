const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const Module = require("node:module");
const electron = require("electron");
const root = path.resolve(__dirname, "..");
const profiles = path.join(root, "release", "verification-2.5.0");
fs.mkdirSync(profiles, { recursive: true });
electron.app.setPath("userData", fs.mkdtempSync(path.join(profiles, "electron-profile-")));
const originalLoad = Module._load;
class TestWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, show: false }); }
  loadURL() { return this.loadFile(path.join(root, "dist", "index.html")); }
}
Module._load = function (id, ...args) {
  if (id === "electron") return { ...electron, BrowserWindow: TestWindow };
  return originalLoad.call(this, id, ...args);
};
const probe = net.createServer();
probe.listen(0, "127.0.0.1", () => {
  const port = probe.address().port;
  probe.close(() => {
    process.argv.push("--port", String(port));
    require("../electron/main.cjs");
  });
});
