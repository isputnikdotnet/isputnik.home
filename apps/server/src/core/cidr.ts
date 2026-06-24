// CIDR membership test for trusted-network zones. Supports IPv4 and IPv6 (both as
// 32/128-bit big integers so the same masking logic covers both). A bare address
// with no "/" is treated as a single-host range (/32 or /128).

interface ParsedIp {
  value: bigint;
  bits: 32 | 128;
}

function parseIpv4(ip: string): bigint | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const part = Number(match[i]);
    if (part > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseIpv6(ip: string): bigint | null {
  let text = ip;
  // Expand an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) into two hex groups.
  const tail = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const v4 = parseIpv4(tail[2]);
    if (v4 === null) return null;
    const hex = v4.toString(16).padStart(8, "0");
    text = `${tail[1]}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (head.length + back.length > 7) {
    return null;
  }
  const fill = halves.length === 2 ? Array(8 - head.length - back.length).fill("0") : [];
  const groups = [...head, ...fill, ...back];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function parseIp(ip: string): ParsedIp | null {
  const clean = ip.trim().toLowerCase().split("%")[0]; // drop any zone id
  if (clean.includes(":")) {
    const mapped = clean.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) {
      const v4 = parseIpv4(mapped[1]);
      return v4 === null ? null : { value: v4, bits: 32 };
    }
    const v6 = parseIpv6(clean);
    return v6 === null ? null : { value: v6, bits: 128 };
  }
  const v4 = parseIpv4(clean);
  return v4 === null ? null : { value: v4, bits: 32 };
}

function prefixOf(cidr: string, bits: 32 | 128): number | null {
  const slash = cidr.indexOf("/");
  if (slash === -1) return bits;
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  return prefix;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const range = parseIp(slash === -1 ? cidr : cidr.slice(0, slash));
  const address = parseIp(ip);
  if (!range || !address || range.bits !== address.bits) return false;

  const prefix = prefixOf(cidr, range.bits);
  if (prefix === null) return false;

  const hostBits = BigInt(range.bits - prefix);
  const widthMask = (1n << BigInt(range.bits)) - 1n;
  const mask = (~((1n << hostBits) - 1n)) & widthMask;
  return (address.value & mask) === (range.value & mask);
}

export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}

// True when the string is a usable address or CIDR (for validating admin input).
export function isValidCidr(cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const range = parseIp(slash === -1 ? cidr : cidr.slice(0, slash));
  if (!range) return false;
  return prefixOf(cidr, range.bits) !== null;
}
