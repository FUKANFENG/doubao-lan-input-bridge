import { describe, expect, it } from "vitest";
import {
  choosePreferredAddress,
  collectLanCandidates,
  rankAddress
} from "./network";

describe("collectLanCandidates", () => {
  it("keeps real private LAN addresses and removes loopback/link-local/internal addresses", () => {
    const candidates = collectLanCandidates({
      "Loopback Pseudo-Interface 1": [
        { address: "127.0.0.1", family: "IPv4", internal: true }
      ],
      "vEthernet (WSL)": [
        { address: "172.28.160.1", family: "IPv4", internal: false }
      ],
      "以太网": [{ address: "192.168.1.48", family: "IPv4", internal: false }],
      "Bluetooth": [{ address: "169.254.10.2", family: "IPv4", internal: false }]
    });

    expect(candidates.map((item) => item.address)).toEqual(["192.168.1.48"]);
  });

  it("keeps ZeroTier as a fallback candidate but ranks normal LAN above it", () => {
    const candidates = collectLanCandidates({
      "ZeroTier One [af78bf9436146185]": [
        { address: "172.26.180.117", family: "IPv4", internal: false }
      ],
      "以太网": [{ address: "192.168.1.48", family: "IPv4", internal: false }]
    });

    expect(candidates.map((item) => item.address)).toEqual([
      "192.168.1.48",
      "172.26.180.117"
    ]);
    expect(candidates[1].isVirtual).toBe(true);
  });
});

describe("choosePreferredAddress", () => {
  it("prefers 192.168 private LAN over virtual and tunnel adapters", () => {
    const preferred = choosePreferredAddress([
      { address: "172.26.180.117", interfaceName: "ZeroTier One", isVirtual: true },
      { address: "192.168.1.48", interfaceName: "以太网", isVirtual: false },
      { address: "10.8.0.2", interfaceName: "VPN", isVirtual: true }
    ]);

    expect(preferred?.address).toBe("192.168.1.48");
  });
});

describe("rankAddress", () => {
  it("scores common LAN ranges before virtual ranges", () => {
    expect(rankAddress("192.168.1.48", false)).toBeLessThan(
      rankAddress("172.26.180.117", true)
    );
  });
});
