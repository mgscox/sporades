import { isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { ACCESS_KEY_CLIENT_ADDRESS_HEADER } from "./access-key-contract.js";

export const CLIENT_ADDRESS_TOKEN_HEADER = "x-sporades-client-address-token";
type Address = { family: 4 | 6; bits: bigint; canonical: string; mapped: boolean };

/** IP literals only: no lists, ports, brackets, zones or whitespace. Mapped IPv6 is IPv4. */
function parseAddress(value: unknown): Address | null {
  if (typeof value !== "string" || value.length > 45 || /[%\s]/.test(value)) return null;
  const family = isIP(value);
  if (family === 4) {
    return { family: 4, bits: value.split(".").reduce((bits, part) => (bits << 8n) | BigInt(part), 0n), canonical: value, mapped: false };
  }
  if (family !== 6) return null;
  let expanded = value.toLowerCase();
  if (expanded.includes(".")) {
    const colon = expanded.lastIndexOf(":");
    const octets = expanded.slice(colon + 1).split(".").map(Number);
    expanded = `${expanded.slice(0, colon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [left, right] = expanded.split("::");
  const groups = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  if (right !== undefined) groups.push(...Array(8 - groups.length - tail.length).fill("0"), ...tail);
  const words = groups.map(part => parseInt(part, 16));
  const bits = words.reduce((bits, word) => (bits << 16n) | BigInt(word), 0n);
  if ((bits >> 32n) === 0xffffn) {
    const ipv4 = Number(bits & 0xffffffffn);
    return { family: 4, bits: bits & 0xffffffffn, canonical: [ipv4 >>> 24, (ipv4 >>> 16) & 255, (ipv4 >>> 8) & 255, ipv4 & 255].join("."), mapped: true };
  }
  // RFC 5952: compress the first longest zero run of at least two words.
  let start = -1, length = 1;
  for (let i = 0; i < words.length;) {
    if (words[i] !== 0) { i++; continue; }
    const from = i; while (i < words.length && words[i] === 0) i++;
    if (i - from > length) { start = from; length = i - from; }
  }
  const hex = words.map(word => word.toString(16));
  const canonical = start < 0 ? hex.join(":") : `${hex.slice(0, start).join(":")}::${hex.slice(start + length).join(":")}`;
  return { family: 6, bits, canonical, mapped: false };
}

export function canonicalClientAddress(value: unknown): string | null { return parseAddress(value)?.canonical ?? null; }

function parseNetwork(value: string) {
  const [literal, prefix, extra] = value.split("/");
  const address = parseAddress(literal);
  if (!address || extra !== undefined || (prefix !== undefined && !/^(0|[1-9][0-9]{0,2})$/.test(prefix))) return null;
  const width = address.family === 4 ? 32 : 128;
  let length = prefix === undefined ? width : Number(prefix);
  if (address.mapped && prefix !== undefined) {
    if (length < 96 || length > 128) return null;
    length -= 96;
  }
  if (length > width) return null;
  return { address, shift: BigInt(width - length) };
}

export function validClientAddressNetwork(value: string): boolean { return parseNetwork(value) !== null; }

export function clientAddressMatches(address: string, network: string): boolean {
  const client = parseAddress(address), range = parseNetwork(network);
  return !!client && !!range && client.family === range.address.family
    && (client.bits >> range.shift) === (range.address.bits >> range.shift);
}

/** Domain-separated from health-control authority; owned by Host, never Capsule configuration. */
export function clientAddressBoundaryToken(probeToken: string): string {
  return createHash("sha256").update("sporades-client-address\0").update(probeToken).digest("hex");
}

function singleHeader(request: any, name: string): string | null {
  const value = request?.headers?.[name];
  if (typeof value !== "string") return null;
  if (Array.isArray(request.rawHeaders)) {
    let count = 0;
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (String(request.rawHeaders[i]).toLowerCase() === name) count++;
    if (count !== 1) return null;
  }
  return value;
}

/** The network is untrusted even in Hosted. Require the Host's per-runtime capability. */
export function trustedClientAddress(database: any, request: any): string | null {
  if (database.securitySession !== "hosted" || typeof database.runtimeProbeToken !== "string" || !/^[a-f0-9]{64}$/.test(database.runtimeProbeToken)) return null;
  const token = singleHeader(request, CLIENT_ADDRESS_TOKEN_HEADER);
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(clientAddressBoundaryToken(database.runtimeProbeToken), "hex"))) return null;
  return canonicalClientAddress(singleHeader(request, ACCESS_KEY_CLIENT_ADDRESS_HEADER));
}
