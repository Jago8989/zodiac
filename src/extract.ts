import { getAddress } from "ethers";
import { predictSingletonAddress } from "@gnosis-guild/zodiac-core";

import { resolveNetwork } from "./networks.js";
import {
  getCode,
  getContractCreation,
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
    networkName: net.name,
    apiKey,
    visited,
  });
  return visited;
}

async function extractOne({
  address,
  nameHint,
  networkName,
  apiKey,
  visited,
}: {
  address: string;
  nameHint?: string;
  networkName: string;
  apiKey?: string;
  visited: Map<string, Asset>;
}): Promise<Asset> {
  const key = getAddress(address).toLowerCase();
  const existing = visited.get(key);
  if (existing) return existing;

  const source = await getSourceCode({ address, network: networkName, apiKey });
  const name = nameHint || source.contractName;

  const creation = await getContractCreation({
    address,
    network: networkName,
    apiKey,
  });
  const tx = creation?.txHash
    ? await getTransaction({
        txHash: creation.txHash,
        network: networkName,
        apiKey,
      })
    : undefined;
  const recovered = tx && recoverDeployment(tx);
  if (!recovered) {
    throw new Error(
      `${name} @ ${address} was not deployed via a known singleton factory.`
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
      networkName,
      apiKey,
      visited,
    });
  }

  return asset;
}
