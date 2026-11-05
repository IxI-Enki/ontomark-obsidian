// Endpoint validation shared by assisted ingest and the Jev option. Pure: no Obsidian import.

export interface EndpointPolicy {
  /**
   * Accept plain `http:` to a host that is not this machine. Off by default:
   * the session key travels as a bearer header and the note text as the body,
   * both readable by anyone on the path.
   */
  allowInsecureHttp?: boolean;
}

/**
 * Is `hostname` (as the WHATWG URL parser normalises it) this machine?
 * `localhost`, any `*.localhost` name (RFC 6761), 127.0.0.0/8 and `[::1]`.
 * The parser has already turned spellings such as `127.1` or `2130706433`
 * into dotted form and lower-cased the name.
 */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Why a URL can be refused as an ingest or Jev endpoint, or `null` if it is usable.
 *
 * Obsidian's `requestUrl` follows redirects and reports neither the final
 * URL nor a way to refuse them, so the "exactly one destination" promise
 * rests on the endpoint itself: it must be an absolute `http(s)` URL with no
 * embedded credentials, and the host must answer directly. A 3xx reply is
 * treated as unavailable (see `callModel`) rather than followed.
 *
 * `https:` is always accepted. Plain `http:` is accepted for this machine
 * (see `isLoopbackHost`); to any other host only when the user turned on
 * `allowInsecureHttp`, because the bearer key and the note text would cross
 * the network unencrypted.
 */
export function endpointProblem(endpoint: string, policy: EndpointPolicy = {}): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "the endpoint is not an absolute URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "the endpoint must use http or https";
  if (u.username || u.password) return "the endpoint must not embed credentials";
  if (u.hash) return "the endpoint must not have a #fragment";
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname) && policy.allowInsecureHttp !== true) {
    return "plain http is only accepted for this machine (localhost); use https, or turn on \"Allow plain http to other hosts\"";
  }
  return null;
}
