import { contextBridge, ipcRenderer } from "electron";
import type { BridgeApi, BridgeState } from "../shared/types";

const api: BridgeApi = {
  getState: () => ipcRenderer.invoke("bridge:get-state"),
  start: () => ipcRenderer.invoke("bridge:start"),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  refresh: () => ipcRenderer.invoke("bridge:refresh"),
  selectAddress: (address: string) => ipcRenderer.invoke("bridge:select-address", address),
  regenerateKey: () => ipcRenderer.invoke("bridge:regenerate-key"),
  copyText: (text: string) => ipcRenderer.invoke("shell:copy-text", text),
  openUrl: (url: string) => ipcRenderer.invoke("shell:open-url", url),
  onStateChanged: (callback: (state: BridgeState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BridgeState) => callback(state);
    ipcRenderer.on("bridge:state-changed", listener);
    return () => ipcRenderer.removeListener("bridge:state-changed", listener);
  }
};

contextBridge.exposeInMainWorld("bridge", api);
