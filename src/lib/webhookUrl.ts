import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Where a webhook may be sent. Only public https addresses: never this machine, a private network, link-local
// (cloud metadata) or other reserved ranges, so a webhook can't be used to reach internal services. The address is
// checked when the webhook is registered and again on every delivery, at connect time (a name that later points at a
// private address is refused then).

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
// (not ::ffff:0:0/96: BlockList applies an IPv4-mapped rule to every IPv4 address; mapped ones are unwrapped below)
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(network, prefix, "ipv6");

/** True for an address a webhook must never be sent to. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // an IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface UrlRules {
  /** development only: allow http://localhost (a receiver on this machine) */
  allowLocalhost: boolean;
}

/** Why this URL can't be a webhook destination, or null if its form is fine (its address is checked separately). */
export function webhookUrlProblem(raw: string, { allowLocalhost }: UrlRules): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a valid URL";
  }
  const local = allowLocalhost && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "must use https";
  if (url.username || url.password) return "must not contain a username or password";
  if (raw.length > 2048) return "must be at most 2048 characters";
  if (!local && isIP(url.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ""))) return "must be a public address";
  if (!local && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".internal") || url.hostname.endsWith(".local"))) return "must be a public address";
  return null;
}

/**
 * A DNS lookup for http(s).request that refuses blocked addresses, so the check happens on the address actually
 * connected to. `allow` lets one host through regardless (localhost in development).
 */
export function safeLookup(allow?: (hostname: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, []);
      const usable = allow?.(hostname) ? addresses : addresses.filter((entry) => !isBlockedAddress(entry.address));
      if (usable.length === 0) {
        const refused: NodeJS.ErrnoException = Object.assign(new Error(`${hostname} resolves only to private or reserved addresses`), { code: "EBLOCKED" });
        return callback(refused, []);
      }
      if (options.all) return callback(null, usable);
      const first = usable[0]!;
      callback(null, first.address, first.family);
    });
  };
}

/** Resolves a host and says whether every address it gives is public (registration-time check). */
export function resolvesPublicly(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => resolve(!error && addresses.length > 0 && addresses.every((entry) => !isBlockedAddress(entry.address))));
  });
}
