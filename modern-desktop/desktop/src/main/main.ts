import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import path from "node:path";
import { BridgeServiceManager } from "./serviceManager";
import type { BridgeState } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let manager: BridgeServiceManager;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 640,
    title: "Doubao LAN Input",
    backgroundColor: "#eef3f8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }
}

function registerIpc(): void {
  const withBroadcast = async (action: () => Promise<BridgeState>) => {
    const state = await action();
    mainWindow?.webContents.send("bridge:state-changed", state);
    return state;
  };

  ipcMain.handle("bridge:get-state", () => manager.getState());
  ipcMain.handle("bridge:start", () => withBroadcast(() => manager.start()));
  ipcMain.handle("bridge:stop", () => withBroadcast(() => manager.stop()));
  ipcMain.handle("bridge:refresh", () => withBroadcast(() => manager.refresh()));
  ipcMain.handle("bridge:select-address", (_event, address: string) =>
    withBroadcast(() => manager.selectAddress(address))
  );
  ipcMain.handle("bridge:regenerate-key", () => withBroadcast(() => manager.regenerateKey()));
  ipcMain.handle("shell:copy-text", (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("shell:open-url", (_event, url: string) => shell.openExternal(url));
}

app.whenReady().then(async () => {
  manager = new BridgeServiceManager(app.isPackaged, process.resourcesPath);
  registerIpc();
  createWindow();
  const state = await manager.start();
  mainWindow?.webContents.once("did-finish-load", () => {
    mainWindow?.webContents.send("bridge:state-changed", state);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  event.preventDefault();
  await manager?.stop();
  app.exit(0);
});
