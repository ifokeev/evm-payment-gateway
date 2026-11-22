import { fallback, type HttpTransport, type HttpTransportConfig, http } from "viem";
import { safeErrorText } from "./errors";

const MAX_REASON_LENGTH = 300;
// viem rejects every caller of a failed JSON-RPC batch with its own copy of the error, so the
// same failure reaches this logger once per caller. Identical lines inside this window collapse.
const DUPLICATE_FAILURE_WINDOW_MS = 1_000;

export function rpcTransport(rpcUrls: string[], config: HttpTransportConfig = {}) {
  const recentFailures = new Map<string, number>();
  return fallback(
    rpcUrls.map((url) => loggedHttp(url, config, recentFailures)),
    { retryCount: 0 },
  );
}

// The fallback transport throws only the error of the last endpoint, so every endpoint logs its
// own failure. Only the host is logged because the URL path can carry the provider API key.
function loggedHttp(
  url: string,
  config: HttpTransportConfig,
  recentFailures: Map<string, number>,
): HttpTransport {
  const host = new URL(url).host;
  const transport = http(url, config);
  return (parameters) => {
    const client = transport(parameters);
    const request = (async (args, options) => {
      try {
        return await client.request(args, options);
      } catch (error) {
        logEndpointFailure(recentFailures, host, args.method, error);
        throw error;
      }
    }) as typeof client.request;
    return { ...client, request };
  };
}

function logEndpointFailure(
  recentFailures: Map<string, number>,
  host: string,
  method: string,
  error: unknown,
): void {
  const reason = failureReason(error);
  const key = `${host} ${reason}`;
  const now = Date.now();
  const lastLoggedAt = recentFailures.get(key);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < DUPLICATE_FAILURE_WINDOW_MS) return;
  recentFailures.set(key, now);
  console.warn("rpc endpoint failed", host, method, reason);
}

// The request body of a failed call lists every watched deposit address, so it is left out.
function failureReason(error: unknown): string {
  return safeErrorText(error)
    .split("\n")
    .filter((line) => !line.startsWith("Request body:"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
}
