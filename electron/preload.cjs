const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeApi", {
  getStatus: () => ipcRenderer.invoke("bridge:get-status"),
  start: (port) => ipcRenderer.invoke("bridge:start", port),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  setMode: (mode) => ipcRenderer.invoke("bridge:set-mode", mode),
  getAutomation: () => ipcRenderer.invoke("bridge:get-automation"),
  captureAppBinding: (mode, delayMs) => ipcRenderer.invoke("bridge:capture-app-binding", mode, delayMs),
  updateAppBinding: (processKey, mode) => ipcRenderer.invoke("bridge:update-app-binding", processKey, mode),
  deleteAppBinding: (processKey) => ipcRenderer.invoke("bridge:delete-app-binding", processKey),
  regenerateKey: () => ipcRenderer.invoke("bridge:regenerate-key"),
  openUrl: (url) => ipcRenderer.invoke("bridge:open-url", url),
  copyText: (text) => ipcRenderer.invoke("bridge:copy-text", text),
  setAudioState: (state) => ipcRenderer.invoke("bridge:set-audio-state", state),
  sendAudioChunk: (chunk) => ipcRenderer.invoke("bridge:audio-chunk", chunk),
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
