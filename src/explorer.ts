import { resolveNetwork } from "./networks.js";

/**
 * Minimal Etherscan-compatible explorer client.
 *
 * Everything `extract` needs is reachable through the explorer:
 *  - `getsourcecode`     -> verified source, ABI, compiler input, constructor args
 *  - `getcontractcreation` -> the deployment transaction hash
 *  - `eth_getTransactionByHash` (proxy module) -> the raw deployment calldata
 *
 * so no separate JSON-RPC endpoint is required for extraction.
 */

export interface SourceCode {
  contractName: string;
  sourceName: string;
  compilerVersion: string;
  compilerInput: any;
  abi: any;
  /** abi-encoded constructor arguments (hex, no leading 0x). */
  constructorArguments: string;
}

function isOk(status: unknown): boolean {
  return String(status) === "1";
}

/**
 * Etherscan double-wraps the standard-JSON source in extra braces. Parse
 * tolerantly so both `{{...}}` and `{...}` payloads succeed.
 */
function safeJsonParse(input: string): any {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return JSON.parse(trimmed.replace(/^\{|\}$/g, "").trim());
  }
}

function resolveApiKey(network: string, explicit?: string): string {
  const apiKey =
    explicit ||
    process.env[`ETHERSCAN_API_KEY_${network.toUpperCase()}`] ||
    process.env.ETHERSCAN_API_KEY ||
    "";
  return apiKey;
}

/**
 * Resolve the explorer endpoint and the base query params (api key and, for the
 * Etherscan V2 multichain endpoint, the chain id) for a network.
 */
function explorerTarget(
  networkOrChainId: string | number,
  apiKey?: string
): { url: string; base: Record<string, string> } {
  const network = resolveNetwork(networkOrChainId);
  if (!network.etherscanApiUrl) {
    throw new Error(
      `${network.name} (chain ${network.chainId}) is not supported by Etherscan ` +
        `V2; cannot extract. See https://api.etherscan.io/v2/chainlist`
    );
  }
  // etherscanApiUrl already carries `?chainid=`; only the api key is added here.
  const base: Record<string, string> = {
    apikey: resolveApiKey(network.name, apiKey),
  };
  return { url: network.etherscanApiUrl, base };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(body: any): boolean {
  const text = `${body?.message ?? ""} ${body?.result ?? ""}`.toLowerCase();
  return text.includes("rate limit");
}

/**
 * GET against the explorer, retrying with backoff when the free-tier rate limit
 * is hit (recursive extraction fires several requests in quick succession).
 */
async function explorerGet(
  apiUrl: string,
  params: Record<string, string>,
  attempt = 0
): Promise<any> {
  const url = new URL(apiUrl);
  // Merge onto the URL's existing query so the embedded `chainid` is preserved.
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Explorer request failed: ${response.status}`);
  }
  const body = await response.json();
  if (isRateLimited(body) && attempt < 5) {
    await sleep(1000 * (attempt + 1));
    return explorerGet(apiUrl, params, attempt + 1);
  }
  return body;
}

/**
 * Fetch verified source, ABI and compiler input for a deployed contract.
 */
export async function getSourceCode({
  address,
  network,
  apiKey,
}: {
  address: string;
  network: string | number;
  apiKey?: string;
}): Promise<SourceCode> {
  const { url, base } = explorerTarget(network, apiKey);

  const { status, message, result } = await explorerGet(url, {
    ...base,
    module: "contract",
    action: "getsourcecode",
    address,
  });

  if (!isOk(status)) {
    throw new Error(
      `getsourcecode failed for ${address}: ${message}${
        result ? ` (${result})` : ""
      }`
    );
  }

  const entry = result[0];
  if (!entry?.SourceCode) {
    throw new Error(`Contract ${address} is not verified on ${network}`);
  }

  const compilerInput = safeJsonParse(entry.SourceCode);
  const contractName = entry.ContractName as string;
  const sourceName = sourceNameFor(compilerInput, contractName);

  return {
    contractName,
    sourceName,
    compilerVersion: entry.CompilerVersion,
    compilerInput,
    abi: entry.ABI ? safeJsonParse(entry.ABI) : undefined,
    constructorArguments: entry.ConstructorArguments || "",
  };
}

/**
 * Resolve the full source path for a contract name within a standard-JSON input.
 */
function sourceNameFor(compilerInput: any, contractName: string): string {
  const sources = compilerInput?.sources || {};
  // Prefer a source file whose path basename matches the contract name.
  const match = Object.keys(sources).find(
    (path) =>
      path
        .split("/")
        .pop()
        ?.replace(/\.sol$/, "") === contractName
  );
  if (match) return match;
  const [only] = Object.keys(sources);
  if (only) return only;
  throw new Error(`Could not resolve sourceName for ${contractName}`);
}

/**
 * Get the transaction hash that created a contract.
 */
export async function getContractCreationTx({
  address,
  network,
  apiKey,
}: {
  address: string;
  network: string | number;
  apiKey?: string;
}): Promise<string | undefined> {
  const { url, base } = explorerTarget(network, apiKey);

  const { status, result } = await explorerGet(url, {
    ...base,
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: address,
  });

  if (!isOk(status) || !Array.isArray(result) || result.length === 0) {
    return undefined;
  }
  return result[0].txHash as string;
}

/**
 * Fetch a transaction (input + to) via the explorer's proxy module.
 */
export async function getTransaction({
  txHash,
  network,
  apiKey,
}: {
  txHash: string;
  network: string | number;
  apiKey?: string;
}): Promise<{ to: string | null; input: string } | undefined> {
  const { url, base } = explorerTarget(network, apiKey);

  const { result } = await explorerGet(url, {
    ...base,
    module: "proxy",
    action: "eth_getTransactionByHash",
    txhash: txHash,
  });

  if (!result?.input) return undefined;
  return { to: result.to ?? null, input: result.input as string };
}

/**
 * Fetch the deployed (runtime) bytecode at an address via the proxy module.
 */
export async function getCode({
  address,
  network,
  apiKey,
}: {
  address: string;
  network: string | number;
  apiKey?: string;
}): Promise<string> {
  const { url, base } = explorerTarget(network, apiKey);

  const { result } = await explorerGet(url, {
    ...base,
    module: "proxy",
    action: "eth_getCode",
    address,
    tag: "latest",
  });

  return (result as string) ?? "0x";
}
