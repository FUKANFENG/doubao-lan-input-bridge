export type NetworkAddress = {
  address: string;
  family: string | number;
  internal?: boolean;
};

export type NetworkInterfaces = Record<string, NetworkAddress[] | undefined>;

export type LanCandidate = {
  address: string;
  interfaceName: string;
  isVirtual: boolean;
};

const VIRTUAL_INTERFACE_PATTERN = /(vEthernet|WSL|ZeroTier|VPN|VirtualBox|VMware|Hyper-V|Tailscale|Loopback)/i;

export function collectLanCandidates(interfaces: NetworkInterfaces): LanCandidate[] {
  const candidates: LanCandidate[] = [];

  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    for (const item of addresses ?? []) {
      if (!isIPv4(item) || item.internal || !isPrivateIPv4(item.address)) {
        continue;
      }

      const isVirtual = VIRTUAL_INTERFACE_PATTERN.test(interfaceName);
      if (isExcludedVirtual(interfaceName)) {
        continue;
      }

      candidates.push({ address: item.address, interfaceName, isVirtual });
    }
  }

  return candidates.sort((a, b) => {
    const rank = rankAddress(a.address, a.isVirtual) - rankAddress(b.address, b.isVirtual);
    return rank === 0 ? a.address.localeCompare(b.address) : rank;
  });
}

export function choosePreferredAddress(candidates: LanCandidate[]): LanCandidate | null {
  return [...candidates].sort((a, b) => {
    const rank = rankAddress(a.address, a.isVirtual) - rankAddress(b.address, b.isVirtual);
    return rank === 0 ? a.interfaceName.localeCompare(b.interfaceName) : rank;
  })[0] ?? null;
}

export function rankAddress(address: string, isVirtual: boolean): number {
  let score = isVirtual ? 100 : 0;
  if (address.startsWith("192.168.")) {
    score += 0;
  } else if (address.startsWith("10.")) {
    score += 10;
  } else if (is172Private(address)) {
    score += 20;
  } else {
    score += 50;
  }
  return score;
}

function isIPv4(item: NetworkAddress): boolean {
  return item.family === "IPv4" || item.family === 4;
}

function isPrivateIPv4(address: string): boolean {
  return (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    is172Private(address)
  );
}

function is172Private(address: string): boolean {
  const match = /^172\.(\d{1,2})\./.exec(address);
  if (!match) {
    return false;
  }
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function isExcludedVirtual(interfaceName: string): boolean {
  return /(vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback)/i.test(interfaceName);
}
