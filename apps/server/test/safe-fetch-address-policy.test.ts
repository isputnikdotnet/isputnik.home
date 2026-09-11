// The SSRF door's address policy (core/safe-fetch.ts), and the proof that it is
// shut: cover art, author photos from a pasted URL, recipe imports and metadata
// pages all reach the internet through fetchSafely, and every one of those URLs
// can come from someone other than the admin — a provider's JSON, a family member
// pasting a link. The one thing the door must never do is open onto this machine,
// its LAN, or a cloud metadata endpoint.
//
// Two halves. isBlockedAddress is tabled against every range it must refuse, in
// every spelling an address can arrive in. Then the whole path is driven at a real
// HTTP server listening on 127.0.0.1 — by literal address, by the aliases the URL
// parser folds into it, by a hostname whose DNS answer points home — and the server
// must see NO request at all. The only DNS stubbed is for made-up hostnames; nothing
// here leaves the machine, because nothing is allowed to connect.
import http from "node:http";
import type { AddressInfo } from "node:net";
import dns from "node:dns/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isBlockedAddress } from "../src/core/safe-fetch.js";
import { downloadImage, fetchTextFromUrl } from "../src/modules/library/shared/remote-image.js";

describe("which addresses are refused", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "the rest of 127/8"],
    ["0.0.0.0", "this host"],
    ["10.1.2.3", "RFC 1918 10/8"],
    ["172.16.0.1", "RFC 1918 172.16/12, low edge"],
    ["172.31.255.255", "RFC 1918 172.16/12, high edge"],
    ["192.168.1.10", "RFC 1918 192.168/16"],
    ["169.254.169.254", "the cloud metadata endpoint"],
    ["169.254.0.1", "IPv4 link-local"],
    ["100.64.0.1", "CGNAT 100.64/10"],
    ["::1", "IPv6 loopback"],
    ["0:0:0:0:0:0:0:1", "IPv6 loopback, uncompressed"],
    ["::", "IPv6 unspecified"],
    ["[::1]", "IPv6 loopback in URL brackets"],
    ["fe80::1", "IPv6 link-local"],
    ["febf::1", "IPv6 link-local, top of fe80::/10"],
    ["fc00::1", "IPv6 unique-local fc00::/7"],
    ["fd12:3456:789a::1", "IPv6 unique-local, the fd half"],
    ["FD00::1", "upper-case"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex — how the URL parser writes it"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata endpoint, dotted"],
    ["::ffff:a9fe:a9fe", "IPv4-mapped metadata endpoint, hex"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["not-an-address", "anything that is not an address at all"]
  ])("refuses %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["8.8.8.8"],
    ["93.184.216.34"],
    ["172.15.255.255"], // just below 172.16/12
    ["172.32.0.1"], // just above it
    ["192.169.0.1"],
    ["100.63.255.255"], // just below CGNAT
    ["100.128.0.1"], // just above it
    ["169.253.0.1"],
    ["2606:4700:4700::1111"],
    ["2a00:1450:4001:80b::200e"],
    ["::ffff:8.8.8.8"],
    ["::ffff:808:808"]
  ])("lets a public address through: %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

// ── The whole path, against a real listener on this machine ─────────────────

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "image/png" });
    res.end("not really a png");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
  hits = 0;
});

// Resolve made-up hostnames to what a hostile DNS server would answer; leave
// everything else (localhost, IP literals) to the real resolver.
function fakeDns(answers: Record<string, { address: string; family: number }[]>) {
  const real = dns.lookup.bind(dns);
  vi.spyOn(dns, "lookup").mockImplementation((async (hostname: string, options?: unknown) => {
    if (hostname in answers) return answers[hostname];
    return real(hostname, options as never);
  }) as typeof dns.lookup);
}

describe("a URL that leads back to this machine", () => {
  it("(control: the listener really answers a plain fetch)", async () => {
    // Without this, "zero hits" below could just mean nothing was listening.
    const res = await fetch(`http://127.0.0.1:${port}/cover.png`);
    await res.arrayBuffer();
    expect(hits).toBe(1);
  });

  it.each([
    ["http://127.0.0.1:PORT/cover.png", "the loopback literal"],
    ["http://localhost:PORT/cover.png", "localhost, resolved for real"],
    ["http://127.1:PORT/cover.png", "the short form the URL parser expands"],
    ["http://2130706433:PORT/cover.png", "a decimal IPv4"],
    ["http://0x7f.0.0.1:PORT/cover.png", "a hex octet"],
    ["http://0.0.0.0:PORT/cover.png", "the unspecified address"],
    ["http://[::ffff:127.0.0.1]:PORT/cover.png", "IPv4-mapped IPv6"],
    ["http://[::1]:PORT/cover.png", "IPv6 loopback"]
  ])("is refused before any connection: %s (%s)", async (template) => {
    const url = template.replace("PORT", String(port));

    await expect(downloadImage(url)).rejects.toThrow(/disallowed address/);
    await expect(fetchTextFromUrl(url)).rejects.toThrow(/disallowed address/);
    expect(hits).toBe(0);
  });

  it("is refused when an innocent-looking hostname resolves here", async () => {
    fakeDns({ "covers.example": [{ address: "127.0.0.1", family: 4 }] });

    await expect(downloadImage(`http://covers.example:${port}/c.png`)).rejects.toThrow(/disallowed address/);
    expect(hits).toBe(0);
  });

  it("is refused when ANY of a host's records is private, not just the first", async () => {
    // A public answer next to a private one: checking only the record the socket
    // would use lets the other one in on a retry or a rebinding race.
    fakeDns({
      "mixed.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 }
      ]
    });

    await expect(fetchTextFromUrl(`http://mixed.example:${port}/`)).rejects.toThrow(/disallowed address/);
    expect(hits).toBe(0);
  });

  it.each([
    [[{ address: "169.254.169.254", family: 4 }], "the metadata endpoint"],
    [[{ address: "fd00::1", family: 6 }], "an IPv6 unique-local address"],
    [[{ address: "::ffff:192.168.0.1", family: 6 }], "an IPv4-mapped private address"],
    [[{ address: "fe80::1", family: 6 }], "an IPv6 link-local address"]
  ])("is refused for a hostname resolving to %j (%s)", async (records) => {
    fakeDns({ "evil.example": records });

    await expect(downloadImage("http://evil.example/latest/meta-data/")).rejects.toThrow(/disallowed address/);
  });

  it("is refused when the host has no address at all", async () => {
    fakeDns({ "void.example": [] });

    await expect(downloadImage("http://void.example/x.png")).rejects.toThrow(/could not be resolved/);
  });
});

describe("a URL that is not http(s)", () => {
  it.each([
    ["file:///etc/passwd"],
    ["file:///C:/Windows/win.ini"],
    ["ftp://example.com/cover.png"],
    ["data:image/png;base64,iVBORw0KGgo="],
    ["gopher://127.0.0.1:6379/_INFO"]
  ])("is refused without a lookup: %s", async (url) => {
    const lookup = vi.spyOn(dns, "lookup");

    await expect(downloadImage(url)).rejects.toThrow(/Only http\(s\) URLs/);
    expect(lookup).not.toHaveBeenCalled();
  });
});
