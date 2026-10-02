import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { collectLanCandidates, choosePreferredAddress, type LanCandidate } from "../shared/network";
import type { BridgeState, BridgeStatus } from "../shared/types";
import { buildPhoneUrl, DEFAULT_PORT } from "../shared/urls";

const APP_ID = "DoubaoLanInputBridge";
const BACKEND_EXE = "DoubaoLanInputBridge.exe";

export class BridgeServiceManager {
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private status: BridgeStatus = "stopped";
  private port = DEFAULT_PORT;
  private accessKey = "";
  private selectedAddress = "";
  private message = "服务未启动";
  private addresses: LanCandidate[] = [];

  constructor(private readonly packaged: boolean, private readonly resourcesPath: string) {}

  async getState(): Promise<BridgeState> {
    await this.refreshMetadata();
    return this.snapshot();
  }

  async start(): Promise<BridgeState> {
    if (this.child && this.status === "running") {
      return this.getState();
    }

    this.status = "starting";
    this.message = "正在启动服务";
    await this.refreshMetadata();
    this.port = await findAvailablePort(DEFAULT_PORT);

    const backend = this.resolveBackendPath();
    const child = spawn(backend, ["--server-only", "--port", String(this.port)], {
      windowsHide: true,
      stdio: "ignore"
    });
    this.child = child;
    this.childPid = child.pid ?? null;
    child.once("exit", () => {
      this.child = null;
      this.childPid = null;
      if (this.status !== "stopped") {
        this.status = "stopped";
        this.message = "服务进程已退出";
      }
    });

    try {
      await waitForHealth(this.port);
      await this.refreshMetadata();
      this.status = "running";
      this.message = `服务运行中，端口 ${this.port}`;
    } catch (error) {
      this.status = "error";
      this.message = error instanceof Error ? error.message : "服务启动失败";
    }

    return this.snapshot();
  }

  async stop(): Promise<BridgeState> {
    if (!this.childPid) {
      this.child = null;
      this.status = "stopped";
      this.message = "服务已停止";
      return this.getState();
    }

    await stopProcessTree(this.childPid);
    this.child = null;
    this.childPid = null;
    this.status = "stopped";
    this.message = "服务已停止";
    return this.getState();
  }

  async refresh(): Promise<BridgeState> {
    await this.refreshMetadata();
    return this.snapshot();
  }

  async selectAddress(address: string): Promise<BridgeState> {
    await this.refreshMetadata();
    if (this.addresses.some((item) => item.address === address)) {
      this.selectedAddress = address;
    }
    return this.snapshot();
  }

  async regenerateKey(): Promise<BridgeState> {
    if (this.status === "running") {
      await this.stop();
    }
    this.accessKey = randomBytes(18).toString("base64url");
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.writeFile(keyFile(), `${this.accessKey}\n`, "utf8");
    this.message = "访问密钥已重新生成，请重新启动服务";
    return this.getState();
  }

  private async refreshMetadata(): Promise<void> {
    this.addresses = collectLanCandidates(os.networkInterfaces());
    if (!this.selectedAddress || !this.addresses.some((item) => item.address === this.selectedAddress)) {
      this.selectedAddress = choosePreferredAddress(this.addresses)?.address ?? "127.0.0.1";
    }
    this.accessKey = await readOrCreateAccessKey();
  }

  private snapshot(): BridgeState {
    const localUrl = buildPhoneUrl("127.0.0.1", this.port, this.accessKey);
    const phoneUrl = buildPhoneUrl(this.selectedAddress, this.port, this.accessKey);
    return {
      status: this.status,
      port: this.port,
      accessKey: this.accessKey,
      localUrl,
      phoneUrl,
      selectedAddress: this.selectedAddress,
      addresses: this.addresses,
      message: this.message
    };
  }

  private resolveBackendPath(): string {
    if (this.packaged) {
      return path.join(this.resourcesPath, "backend", BACKEND_EXE);
    }
    return path.resolve(process.cwd(), "..", "doubao-lan-input-gui", "dist", BACKEND_EXE);
  }
}

export async function findAvailablePort(startPort = DEFAULT_PORT): Promise<number> {
  for (let port = startPort; port <= startPort + 30; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`未找到可用端口：${startPort}-${startPort + 30}`);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(150);
    }
  }
  throw new Error("服务启动超时");
}

async function readOrCreateAccessKey(): Promise<string> {
  try {
    const existing = (await fs.readFile(keyFile(), "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Create below.
  }

  const key = randomBytes(18).toString("base64url");
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(keyFile(), `${key}\n`, "utf8");
  return key;
}

function dataDir(): string {
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_ID);
}

function keyFile(): string {
  return path.join(dataDir(), "access_key.txt");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // Process already exited.
  }
}
