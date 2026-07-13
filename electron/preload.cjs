const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeApi", {
  getStatus: () => ipcRenderer.invoke("bridge:get-status"),
  start: (port) => ipcRenderer.invoke("bridge:start", port),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  setMode: (mode) => ipcRenderer.invoke("bridge:set-mode", mode),
  regenerateKey: () => ipcRenderer.invoke("bridge:regenerate-key"),
  openUrl: (url) => ipcRenderer.invoke("bridge:open-url", url),
  copyText: (text) => ipcRenderer.invoke("bridge:copy-text", text),
  setAudioState: (state) => ipcRenderer.invoke("bridge:set-audio-state", state),
  sendAudioChunk: (chunk) => ipcRenderer.send("bridge:audio-chunk", chunk),
  onLog: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("bridge:log", handler);
    return () => ipcRenderer.removeListener("bridge:log", handler);
  },
  onAudioStatus: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("bridge:audio-status", handler);
    return () => ipcRenderer.removeListener("bridge:audio-status", handler);
  }
});
