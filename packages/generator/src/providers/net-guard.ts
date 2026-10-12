/**
 * Outbound guard for provider calls made with a user-supplied (BYOK) base URL. The studio is a trusted process, so a
 * user-chosen URL must not reach loopback, private networks, link-local or cloud metadata addresses. The check runs where
 * the connection is made, on the address actually used, not on the URL text.
 */
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import type { Socket } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Raised when a connection is refused. `byName` is true when the refused address came from resolving a hostname: that
 * outcome must look the same to a user as a name that does not resolve, or the form maps the internal network's names.
 */
export class BlockedAddressError extends Error {
  constructor(
    public readonly address: string,
    public readonly byName = false,
  ) {
    super(`Connection to ${address} refused by the provider network policy.`);
    this.name = "BlockedAddressError";
  }
}

/** The BlockedAddressError in an error's cause chain, if any (SDKs and fetch wrap it). */
export function findBlockedAddressError(error: unknown): BlockedAddressError | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0 && seen.size < 20) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof BlockedAddressError) return current;
    const { cause, errors } = current as { cause?: unknown; errors?: unknown };
    stack.push(cause);
    if (Array.isArray(errors)) stack.push(...errors);
  }
  return undefined;
}

export function isBlockedAddressError(error: unknown): boolean {
  return findBlockedAddressError(error) !== undefined;
}

/** The address a guarded connection was refused for, for server-side logs. */
export function refusedAddress(error: unknown): string | undefined {
  return findBlockedAddressError(error)?.address;
}

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network", includes 0.0.0.0
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
];

// IPv6 is allow-listed to global unicast (2000::/3) minus the special ranges below.
const BLOCKED_V6: [string, number][] = [
  ["::", 96], // unspecified, loopback and the deprecated IPv4-compatible form
  ["::ffff:0:0:0", 96], // SIIT
  ["64:ff9b::", 96], // NAT64: reaches IPv4 hosts through a gateway
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["3fff::", 20], // documentation
];

const v4List = new BlockList();
for (const [net, prefix] of BLOCKED_V4) v4List.addSubnet(net, prefix, "ipv4");
const v6List = new BlockList();
for (const [net, prefix] of BLOCKED_V6) v6List.addSubnet(net, prefix, "ipv6");
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");

/** Canonical eight 16-bit words of an IPv6 address, or null if it doesn't parse. */
function ipv6Words(ip: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${ip}]/`).hostname;
  } catch {
    return null;
  }
  const inner = host.slice(1, -1);
  const [left, right] = inner.includes("::") ? inner.split("::") : [inner, undefined];
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const fill = right === undefined ? 0 : 8 - head.length - tail.length;
  const words = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w)) ? words : null;
}

/**
 * Whether a connection to this literal IP address is acceptable. Anything unparseable is refused.
 * An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is judged as its IPv4 address.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const family = isIP(ip);
  if (family === 4) return !v4List.check(ip, "ipv4");
  if (family !== 6) return false;
  const words = ipv6Words(ip);
  if (!words) return false;
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const v4 = `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`;
    return !v4List.check(v4, "ipv4");
  }
  const canonical = words.map((w) => w.toString(16)).join(":");
  return globalUnicastV6.check(canonical, "ipv6") && !v6List.check(canonical, "ipv6");
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface NetPolicy {
  /** Escape hatch for a local fake provider or model server: no https requirement, no address checks. */
  allowPrivate: boolean;
  /** Whether a peer address may be connected to. Default: isPublicAddress. Test seam. */
  isAddressAllowed?: (address: string) => boolean;
  /** Whether to refuse a non-https base URL. Default: !allowPrivate. */
  requireHttps?: boolean;
  /** DNS resolution used for hostnames. Default: the system resolver. Test seam. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

/** The ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS=1 escape hatch. */
export function allowPrivateProviderUrls(): boolean {
  return process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS === "1";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && isIP(host) === 4;
}

/**
 * Why the escape hatch must not be honoured in this environment, or null when it is off or acceptable. NODE_ENV is
 * often unset on a real deployment, so a studio that is not served from a loopback address counts as one too.
 */
export function escapeHatchProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS !== "1") return null;
  if (env.NODE_ENV === "production") {
    return "ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS must not be set in production: it lets users aim the server at internal addresses.";
  }
  let host: string;
  try {
    host = new URL(env.STUDIO_PUBLIC_URL ?? "http://localhost:3000").hostname;
  } catch {
    return "ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS is set but STUDIO_PUBLIC_URL is not a valid URL.";
  }
  if (!isLoopbackHost(host)) {
    return `ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS must not be set when STUDIO_PUBLIC_URL (${host}) is not a loopback address: it lets users aim the server at internal addresses.`;
  }
  return null;
}

export function defaultNetPolicy(): NetPolicy {
  return { allowPrivate: allowPrivateProviderUrls() };
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

/**
 * Save-time usability check for a user-typed base URL: a readable message, or null when acceptable. Not the security
 * boundary: a hostname can still resolve anywhere, which the connect-time guard catches.
 */
export function checkProviderBaseUrl(raw: string, policy: NetPolicy = defaultNetPolicy()): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter the base URL as a full address, for example https://api.example.com/v1.";
  }
  if (url.username || url.password) return "The base URL must not contain a username or password.";
  const requireHttps = policy.requireHttps ?? !policy.allowPrivate;
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && !requireHttps) return null;
  return "The base URL must start with https://.";
}

/** A dispatcher whose connector refuses non-public peers; the one place the address actually used is known. */
function guardedAgent(policy: NetPolicy): Agent {
  const allowed = policy.isAddressAllowed ?? isPublicAddress;
  const resolveHost = policy.resolve ?? systemResolve;

  // net.connect and tls.connect skip the lookup hook entirely when the host is an IP literal, so literals are checked
  // in the connector below and the hook covers only names. The lookup check refuses before any packet is sent; the
  // socket check afterwards is the backstop for whatever address was really connected.
  const lookup = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    resolveHost(hostname).then(
      (found) => {
        const wanted = options.family === 4 || options.family === 6 ? found.filter((a) => a.family === options.family) : found;
        const blocked = wanted.find((entry) => !allowed(entry.address));
        if (blocked) return callback(new BlockedAddressError(blocked.address, true));
        const first = wanted[0];
        if (!first) {
          const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          err.code = "ENOTFOUND";
          return callback(err);
        }
        if (options.all) return callback(null, wanted);
        return callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error),
    );
  };

  const base = buildConnector({ lookup } as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (opts, callback) => {
    const literal = opts.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !allowed(literal)) {
      callback(new BlockedAddressError(literal), null);
      return;
    }
    base(opts, (error, socket) => {
      if (error || !socket) return callback(error, null);
      const peer = (socket as Socket).remoteAddress;
      if (!peer || !allowed(peer)) {
        socket.destroy();
        callback(new BlockedAddressError(peer ?? "unknown", true), null);
        return;
      }
      callback(null, socket);
    });
  };
  return new Agent({ connect });
}

let sharedAgent: Agent | undefined;

/**
 * A fetch to hand to an SDK client. undici's own fetch is used with its own Agent: mixing the package Agent with Node's
 * bundled fetch would depend on the two undici versions agreeing. Redirects are refused outright. Returns undefined when
 * the policy allows private targets (SDK default fetch).
 */
export function guardedFetch(policy: NetPolicy = defaultNetPolicy()): typeof globalThis.fetch | undefined {
  if (policy.allowPrivate) return undefined;
  const custom = policy.isAddressAllowed || policy.resolve;
  const dispatcher = custom ? guardedAgent(policy) : (sharedAgent ??= guardedAgent(policy));
  const requireHttps = policy.requireHttps ?? true;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (requireHttps && target.protocol !== "https:") throw new BlockedAddressError(target.host);
    // A provider API never needs a redirect, and following one would re-send the body and the key to wherever it points.
    return undiciFetch(input as never, { ...(init as object), redirect: "error", dispatcher } as never);
  }) as typeof globalThis.fetch;
}
