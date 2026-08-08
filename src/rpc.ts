/**
 * Perform a raw JSON-RPC eth_getCode call using fetch.
 * This is used for fast, low-overhead status checks across many networks
 * without initializing a full Ethers provider.
 */
export async function getCode(
  rpcUrl: string,
  address: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RPC returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (payload.error || typeof payload.result !== "string") {
      throw new Error("RPC returned an invalid eth_getCode response");
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}
