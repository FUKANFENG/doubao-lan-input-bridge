import { describe, expect, it } from "vitest";
import { buildPhoneUrl, normalizePort } from "./urls";

describe("buildPhoneUrl", () => {
  it("builds a phone URL with an encoded access key", () => {
    expect(buildPhoneUrl("192.168.1.48", 8765, "abc+/= key")).toBe(
      "http://192.168.1.48:8765/?key=abc%2B%2F%3D%20key"
    );
  });

  it("wraps IPv6 hosts in brackets", () => {
    expect(buildPhoneUrl("fe80::1234", 8765, "token")).toBe(
      "http://[fe80::1234]:8765/?key=token"
    );
  });
});

describe("normalizePort", () => {
  it("keeps valid ports", () => {
    expect(normalizePort(8765)).toBe(8765);
  });

  it("falls back when the port is outside TCP range", () => {
    expect(normalizePort(70000, 8766)).toBe(8766);
    expect(normalizePort(0, 8766)).toBe(8766);
  });
});
