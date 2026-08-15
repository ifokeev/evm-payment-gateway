import { fallback, type HttpTransportConfig, http } from "viem";

export function rpcTransport(rpcUrls: string[], config: HttpTransportConfig = {}) {
  return fallback(
    rpcUrls.map((url) => http(url, config)),
    { retryCount: 0 },
  );
}
