import { describe, expect, it } from "vitest";
import { ipInCidr, ipInAnyCidr, isValidCidr } from "../src/core/cidr.js";

describe("ipInCidr (IPv4)", () => {
  it("matches an address inside the range", () => {
    expect(ipInCidr("192.168.1.50", "192.168.0.0/16")).toBe(true);
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("127.0.0.1", "127.0.0.0/8")).toBe(true);
  });

  it("rejects an address outside the range", () => {
    expect(ipInCidr("192.168.1.50", "192.168.2.0/24")).toBe(false);
    expect(ipInCidr("8.8.8.8", "10.0.0.0/8")).toBe(false);
  });

  it("treats a bare address as a single host", () => {
    expect(ipInCidr("192.168.1.5", "192.168.1.5")).toBe(true);
    expect(ipInCidr("192.168.1.6", "192.168.1.5")).toBe(false);
  });

  it("handles /32 and the whole space", () => {
    expect(ipInCidr("1.2.3.4", "1.2.3.4/32")).toBe(true);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });
});

describe("ipInCidr (IPv6 & mapped)", () => {
  it("matches loopback, link-local, and ULA", () => {
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("fe80::abcd", "fe80::/10")).toBe(true);
    expect(ipInCidr("fc00::1", "fc00::/7")).toBe(true);
  });

  it("does not match across ranges", () => {
    expect(ipInCidr("2001:db8::1", "fe80::/10")).toBe(false);
  });

  it("treats ::ffff: mapped addresses as IPv4", () => {
    expect(ipInCidr("::ffff:192.168.1.10", "192.168.0.0/16")).toBe(true);
  });

  it("never matches across IP versions", () => {
    expect(ipInCidr("192.168.1.1", "fe80::/10")).toBe(false);
    expect(ipInCidr("::1", "10.0.0.0/8")).toBe(false);
  });
});

describe("ipInAnyCidr / isValidCidr", () => {
  it("matches if any range contains the ip", () => {
    expect(ipInAnyCidr("10.0.0.5", ["192.168.0.0/16", "10.0.0.0/8"])).toBe(true);
    expect(ipInAnyCidr("8.8.8.8", ["192.168.0.0/16", "10.0.0.0/8"])).toBe(false);
  });

  it("validates address and CIDR forms", () => {
    expect(isValidCidr("192.168.0.0/16")).toBe(true);
    expect(isValidCidr("192.168.0.1")).toBe(true);
    expect(isValidCidr("fe80::/10")).toBe(true);
    expect(isValidCidr("192.168.0.0/33")).toBe(false);
    expect(isValidCidr("999.1.1.1")).toBe(false);
    expect(isValidCidr("not-an-ip")).toBe(false);
  });
});
