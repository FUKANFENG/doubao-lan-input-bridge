import type { LanCandidate } from "./network";

export type BridgeStatus = "starting" | "running" | "stopped" | "error";

export type BridgeState = {
  status: BridgeStatus;
  port: number;
  accessKey: string;
  localUrl: string;
  phoneUrl: string;
  selectedAddress: string;
  addresses: LanCandidate[];
  message: string;
};

export type BridgeApi = {
  getState: () => Promise<BridgeState>;
  start: () => Promise<BridgeState>;
  stop: () => Promise<BridgeState>;
  refresh: () => Promise<BridgeState>;
  selectAddress: (address: string) => Promise<BridgeState>;
  regenerateKey: () => Promise<BridgeState>;
  copyText: (text: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  onStateChanged: (callback: (state: BridgeState) => void) => () => void;
};
