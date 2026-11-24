import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowserContext } from "playwright";
import { UsageError } from "./config.js";

/**
 * Hosted mode (`stillworks mcp --http --hosted`) opens URLs that strangers send it, so it must never reach
 * the machine it runs on or the network around it: localhost, private ranges, link-local (cloud metadata at
 * 169.254.169.254) and the like. Two layers:
 *
 *   assertPublicURL   before anything opens: the URL must be http(s) and every address its host resolves to public
 *   guardContext      every request the browser makes (pages, scripts, fetches) goes through the same check
 *
 * Best effort, not a sandbox: run the hosted server in a network that can't reach anything internal anyway.
 */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function privateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** True for any address a public web app can't have: loopback, private, link-local, multicast, reserved. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const version = isIP(ip);
  if (version === 4) return privateV4(ip);
  if (version !== 6) return true; // not an address at all: refuse
  // IPv4 inside IPv6 (::ffff:10.0.0.1, ::10.0.0.1, 64:ff9b::10.0.0.1)
  const embedded = ip.match(/(?:^::(?:ffff:)?|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return privateV4(embedded[1]);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) + parseInt(hex[2], 16);
    return privateV4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  if (ip === "::" || ip === "::1") return true;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    first === 0x2001 && ip.startsWith("2001:db8:") // documentation
  );
}

export type HostStatus = "public" | "private" | "unresolved";

const cache = new Map<string, { status: HostStatus; at: number }>();
const CACHE_MS = 60_000;

/** Whether every address `hostname` resolves to is public ("unresolved" when DNS finds nothing). */
export async function hostStatus(hostname: string): Promise<HostStatus> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "private";
  if (isIP(host)) return isPrivateAddress(host) ? "private" : "public";
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  let status: HostStatus;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    status = addresses.length === 0 ? "unresolved" : addresses.every((a) => !isPrivateAddress(a.address)) ? "public" : "private";
  } catch {
    status = "unresolved";
  }
  cache.set(host, { status, at: Date.now() });
  return status;
}

export async function isPublicHost(hostname: string): Promise<boolean> {
  return (await hostStatus(hostname)) === "public";
}

/** Throws a UsageError the agent can act on when the URL isn't a public http(s) web app. */
export async function assertPublicURL(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`"${url}" isn't a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new UsageError("Only http and https URLs can be checked.");
  if (parsed.username || parsed.password) throw new UsageError("URLs with a username or password can't be checked here.");
  const status = await hostStatus(parsed.hostname);
  if (status === "unresolved") throw new UsageError(`Couldn't find ${parsed.hostname}: no DNS record. Check the URL, or publish the app first.`);
  if (status === "private") {
    throw new UsageError(
      `${parsed.hostname} isn't a public address, so the hosted checker can't open it. Pass the app's deployed or preview URL ` +
        "(for example https://my-app.lovable.app or https://my-app.vercel.app). To check localhost, run stillworks on your machine: npx -y stillworks mcp",
    );
  }
}

/** Aborts every browser request to a non-public host. Register it after any other route so it runs first. */
export async function guardContext(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    let url: URL;
    try {
      url = new URL(route.request().url());
    } catch {
      return route.fallback();
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.fallback();
    return (await isPublicHost(url.hostname)) ? route.fallback() : route.abort("blockedbyclient");
  });
  // WebSockets bypass context.route
  await context.routeWebSocket(/.*/, async (ws) => {
    let ok = false;
    try {
      ok = await isPublicHost(new URL(ws.url()).hostname);
    } catch {
      ok = false;
    }
    if (ok) ws.connectToServer();
    else await ws.close({ code: 1008, reason: "blocked" });
  });
}
