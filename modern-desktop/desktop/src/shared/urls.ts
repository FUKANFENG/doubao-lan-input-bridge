export const DEFAULT_PORT = 8765;

export function normalizePort(port: number, fallback = DEFAULT_PORT): number {
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    return port;
  }
  return fallback;
}

export function buildPhoneUrl(host: string, port: number, accessKey: string): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${normalizePort(port)}/?key=${encodeURIComponent(accessKey)}`;
}
