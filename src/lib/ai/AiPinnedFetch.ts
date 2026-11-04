import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

/** The callback shape of dns.lookup that undici's connect.lookup calls. */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Connection-level IP pinning for the 'other' provider (closes the DNS rebinding window, CTO ruling Oct 29 2026).
 * AiHostGuard.resolve validates the address once; the Agent built here connects only to that address. The URL is
 * unchanged, so the Host header stays the hostname, and servername (SNI, certificate check) is set to the hostname.
 * Redirects stay refused by the caller (redirect "manual"); caps are unchanged.
 */
export class AiPinnedFetch {
  /** A dns.lookup replacement that never resolves: it answers with the validated address only. */
  static pinnedLookup(address: string, family: 4 | 6) {
    return (_host: string, opts: LookupOptions | LookupCallback, cb?: LookupCallback): void => {
      const done = (typeof opts === "function" ? opts : cb) as LookupCallback;
      const all = typeof opts === "object" && opts !== null && opts.all === true;
      if (all) done(null, [{ address, family }]);
      else done(null, address, family);
    };
  }

  /** The Agent options: pinned lookup plus SNI as the hostname. Exposed so tests read them without a socket. */
  static agentOptions(hostname: string, address: string, family: 4 | 6) {
    return { connect: { lookup: AiPinnedFetch.pinnedLookup(address, family), servername: hostname } };
  }

  static dispatcher(hostname: string, address: string, family: 4 | 6): Agent {
    return new Agent(AiPinnedFetch.agentOptions(hostname, address, family));
  }

  /** undici's own fetch, so the dispatcher comes from the same undici copy (no interop with Node's bundled one). */
  static readonly fetch = undiciFetch;
}
