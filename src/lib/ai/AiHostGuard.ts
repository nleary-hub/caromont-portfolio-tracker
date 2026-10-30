import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a host name to every address it has. Injectable so tests never touch DNS. */
export type AiHostLookup = (host: string) => Promise<readonly { address: string; family: number }[]>;

/**
 * SSRF guard for the 'other' provider's base URL (QA pre-push FIX 2, Oct 29 2026). Used at key save time and before
 * every list call, after DNS resolution: a host is refused when its name is local (localhost, *.localhost, *.local,
 * *.internal) or when ANY address it resolves to is loopback, private, link-local, CGNAT, "this network", unique local
 * or an IPv4-mapped IPv6 form of one of those. Only short codes come out; never the host or address.
 */
export class AiHostGuard {
  static readonly systemLookup: AiHostLookup = async (host) => dnsLookup(host, { all: true, verbatim: true });

  private static readonly V4_BLOCKED: readonly [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
  ];

  private static v4ToInt(ip: string): number {
    return ip.split(".").reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
  }

  static v4Blocked(ip: string): boolean {
    const n = AiHostGuard.v4ToInt(ip);
    return AiHostGuard.V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (AiHostGuard.v4ToInt(base) & mask);
    });
  }

  /** 8 groups of 16 bits, or null when not parseable. Handles "::" and a dotted IPv4 tail. */
  private static v6Groups(ip: string): number[] | null {
    let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (tail) {
      const n = AiHostGuard.v4ToInt(tail[1]);
      s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
    const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest];
    if (all.length !== 8) return null;
    const out = all.map((g) => parseInt(g, 16));
    return out.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : out;
  }

  static v6Blocked(ip: string): boolean {
    const g = AiHostGuard.v6Groups(ip);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
      return AiHostGuard.v4Blocked(v4);
    }
    return false;
  }

  /** True when a literal address is in a refused range. A non-address string is refused. */
  static ipBlocked(ip: string): boolean {
    const bare = ip.replace(/^\[|\]$/g, "");
    const v = isIP(bare.split("%")[0]);
    if (v === 4) return AiHostGuard.v4Blocked(bare);
    if (v === 6) return AiHostGuard.v6Blocked(bare);
    return true;
  }

  /** Name-only refusal: local names and literal addresses in a refused range. No DNS. */
  static nameBlocked(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!h) return true;
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
    if (isIP(h.split("%")[0])) return AiHostGuard.ipBlocked(h);
    return false;
  }

  /**
   * The full check of a URL's host: name rules, then every resolved address. "ok", or a short refusal code.
   * Fails closed: a lookup error or an empty answer is refused.
   */
  static async check(url: string, lookup: AiHostLookup = AiHostGuard.systemLookup): Promise<"ok" | "blocked_host" | "dns_failed"> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return "blocked_host";
    }
    if (AiHostGuard.nameBlocked(host)) return "blocked_host";
    const bare = host.replace(/^\[|\]$/g, "");
    if (isIP(bare)) return "ok";
    let addrs: readonly { address: string }[];
    try {
      addrs = await lookup(bare);
    } catch {
      return "dns_failed";
    }
    if (!addrs.length) return "dns_failed";
    return addrs.some((a) => AiHostGuard.ipBlocked(a.address)) ? "blocked_host" : "ok";
  }
}
