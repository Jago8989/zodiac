import { getAddress } from "ethers";
import { predictSingletonAddress } from "@gnosis-guild/zodiac-core";

import { resolveNetwork } from "./networks.js";
import {
  getCode,
  getContractCreationTx,
  getSourceCode,
  getTransaction,
} from "./explorer.js";
import { recoverDeployment } from "./singleton.js";
import { Asset } from "./types.js";

/**
 * Enumerate the libraries a contract links, from its standard-JSON compiler
 * input. Shape: `settings.libraries = { [sourceName]: { [libName]: address } }`.
 */
function enumerateLibraries(
  input: any
): { sourceName: string; libraryName: string; address: string }[] {
  const libraries = input?.settings?.libraries || {};
  const out: { sourceName: string; libraryName: string; address: string }[] =
    [];
  for (const sourceName of Object.keys(libraries)) {
    for (const libraryName of Object.keys(libraries[sourceName] || {})) {
      const address = libraries[sourceName][libraryName];
      if (address) out.push({ sourceName, libraryName, address });
    }
  }
  return out;
}

/**
 * Extract an asset (and, recursively, every library it links) from a block
 * explorer.
 *
 * Recursion is depth-first and deduplicated by address, so a library shared by
 * several contracts is fetched once.
 *
 * @returns every asset produced, keyed by lower-cased address.
 */
export async function extract({
  network,
  address,
  apiKey,
}: {
  network: string | number;
  address: string;
  apiKey?: string;
}): Promise<Map<string, Asset>> {
  const net = resolveNetwork(network);
  const visited = new Map<string, Asset>();
  await extractOne({
    address,
    chainId: net.chainId,
    networkName: net.name,
    apiKey,
    visited,
  });
  return visited;
}

async function extractOne({
  address,
  nameHint,
  chainId,
  networkName,
  apiKey,
  visited,
}: {
  address: string;
  nameHint?: string;
  chainId: number;
  networkName: string;
  apiKey?: string;
  visited: Map<string, Asset>;
}): Promise<Asset> {
  const key = getAddress(address).toLowerCase();
  const existing = visited.get(key);
  if (existing) return existing;

  const source = await getSourceCode({ address, network: networkName, apiKey });
  const name = nameHint || source.contractName;

  // Recover the creation bytecode + salt from the deployment transaction. This
  // is what gets relayed to other networks, so it must be a singleton-factory
  // deployment — otherwise the asset isn't address-stable and we bail.
  const deployTx = await getContractCreationTx({
    address,
    network: networkName,
    apiKey,
  });
  const tx = deployTx
    ? await getTransaction({ txHash: deployTx, network: networkName, apiKey })
    : undefined;
  const recovered = tx && recoverDeployment(tx);
  if (!recovered) {
    throw new Error(
      `${name} @ ${address} (${networkName}) was not deployed via a known ` +
        `singleton factory; cannot extract relayable creation bytecode.`
    );
  }

  const { factory, initCode: creationBytecode, salt } = recovered;

  // Sanity: the recovered creation bytecode must reproduce the on-chain address
  // via CREATE2. By construction it always does — a failure means a parsing bug.
  // zodiac-core's helper concatenates bytecode + encoded constructor args; we
  // already hold the full creation bytecode, so pass it as `bytecode` with empty
  // args (the concat is then a no-op).
  const predicted = predictSingletonAddress({
    factory,
    bytecode: creationBytecode,
    constructorArgs: { types: [], values: [] },
    salt,
  });
  if (predicted.toLowerCase() !== key) {
    throw new Error(
      `${name} @ ${address}: recovered creation bytecode reproduces ` +
        `${predicted}, not the on-chain address. Refusing to write.`
    );
  }

  // Deployed (runtime) bytecode actually stored at the address.
  const bytecode = await getCode({ address, network: networkName, apiKey });

  // Record this asset before recursing so shared libraries dedupe correctly.
  const asset: Asset = {
    name,
    abi: source.abi,
    sourceCode: {
      contractName: source.contractName,
      sourceName: source.sourceName,
      compilerVersion: source.compilerVersion,
      input: source.compilerInput,
    },
    bytecode: {
      network: networkName,
      chainId,
      address: predicted,
      factory,
      salt,
      creationBytecode,
      bytecode,
    },
  };
  visited.set(key, asset);

  // Recurse into linked libraries.
  for (const lib of enumerateLibraries(source.compilerInput)) {
    await extractOne({
      address: lib.address,
      nameHint: lib.libraryName,
      chainId,
      networkName,
      apiKey,
      visited,
    });
  }

  return asset;
}
