import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { clearLine, cursorTo } from "readline";

import { Interface, JsonRpcProvider, Wallet, getAddress } from "ethers";

import { CanonicalAddresses, KnownContracts } from "../src/contracts.js";
import { defaultMastercopiesDir } from "../src/mastercopies.js";
import { NetworkConfig, networks } from "../src/networks.js";
import { ERC2470_FACTORY, NICK_FACTORY } from "../src/singleton.js";
import { BytecodeFile } from "../src/types.js";

interface DeploymentCell {
  label: string;
}

interface DeployableAsset {
  name: string;
  bytecode: BytecodeFile;
}

const knownContractNames = Object.values(KnownContracts);
const CHECK = "✓";
const CROSS = "✗";
const QUESTION = "?";

const erc2470Interface = new Interface([
  "function deploy(bytes _initCode, bytes32 _salt) returns (address)",
]);

/**
 * CLI entry for:
 *
 *   zodiac deploy <name> [version]
 *   zodiac deploy list <name> [version]
 */
export async function runDeploy(args: string[]): Promise<void> {
  const [subcommand, name, version] = args;

  switch (subcommand) {
    case "list": {
      if (!name) {
        throw new Error("Usage: zodiac deploy list <name> [version]");
      }
      await listDeployments(name, version);
      break;
    }
    case undefined:
      throw new Error(
        "Usage: zodiac deploy <name> [version] | zodiac deploy list <name> [version]"
      );
    default:
      await deployKnown(subcommand, name);
  }
}

async function deployKnown(name: string, version?: string): Promise<void> {
  const contractName = resolveName(name);
  const versions = CanonicalAddresses[contractName] || {};
  const versionKeys = resolveVersions(contractName, versions, version);

  const total = networks.length * versionKeys.length;
  let completed = 0;
  const rows: { network: string; cells: DeploymentCell[] }[] = [];

  renderProgress(completed, total);
  for (const network of networks) {
    const cells: DeploymentCell[] = [];

    for (const version of versionKeys) {
      const address = versions[version as keyof typeof versions];
      const result = address
        ? await deployTarget({
            contractName,
            version,
            network,
            address,
          })
        : await failedDeployment({
            contractName,
            version,
            network,
            reason: "no address on record",
          });

      cells.push(result);
      completed += 1;
      renderProgress(completed, total);
    }

    rows.push({ network: network.name, cells });
  }

  clearProgress();
  printTable(["network", ...versionKeys], rows, [
    `${color(CHECK, "green")} deployed`,
    `${color(CROSS, "red")} failed deployment`,
  ]);
}

async function listDeployments(name: string, version?: string): Promise<void> {
  const contractName = resolveName(name);
  const versions = CanonicalAddresses[contractName] || {};
  const versionKeys = resolveVersions(contractName, versions, version);

  const requestVersions = versionKeys.filter((version) => {
    const address = versions[version as keyof typeof versions];
    return Boolean(address);
  });
  const total = networks.length * requestVersions.length;
  let completed = 0;
  const rows: { network: string; cells: DeploymentCell[] }[] = [];

  if (total > 0) renderProgress(completed, total);
  for (const network of networks) {
    const cells: DeploymentCell[] = [];

    for (const version of versionKeys) {
      const address = versions[version as keyof typeof versions];
      if (!address) {
        cells.push(errorCell());
        continue;
      }

      cells.push(await checkDeployment(network, address));
      completed += 1;
      if (total > 0) renderProgress(completed, total);
    }

    rows.push({ network: network.name, cells });
  }

  if (total > 0) clearProgress();

  printTable(["network", ...versionKeys], rows, [
    `${color(CHECK, "green")} deployed`,
    `${color(CROSS, "red")} not deployed`,
    `${color(QUESTION, "yellow")} couldn't get status`,
  ]);
}

function resolveName(name: string): KnownContracts {
  const matched = knownContractNames.find(
    (n) => n.toLowerCase() === name.toLowerCase()
  );
  if (!matched) {
    throw new Error(
      `Unknown contract "${name}". Known contracts: ${knownContractNames.join(
        ", "
      )}`
    );
  }
  return matched;
}

function resolveVersions(
  contractName: KnownContracts,
  versions: Record<string, string>,
  version?: string
): string[] {
  const keys = Object.keys(versions);
  if (keys.length === 0) {
    throw new Error(`No versions on record for ${contractName}.`);
  }

  if (version === undefined) return keys;

  if (!keys.includes(version)) {
    throw new Error(
      `Unknown version "${version}" for ${contractName}. Known versions: ${keys.join(
        ", "
      )}`
    );
  }
  return [version];
}

async function checkDeployment(
  network: NetworkConfig,
  address: string
): Promise<DeploymentCell> {
  const rpcUrl = rpcUrlFor(network);
  if (!rpcUrl) return errorCell();

  try {
    const code = await getCode(rpcUrl, address);
    return code === "0x" ? missingCell() : deployedCell();
  } catch {
    return errorCell();
  }
}

async function deployTarget({
  contractName,
  version,
  network,
  address,
}: {
  contractName: KnownContracts;
  version: string;
  network: NetworkConfig;
  address: string;
}): Promise<DeploymentCell> {
  const rpcUrl = rpcUrlFor(network);
  if (!rpcUrl) {
    return failedDeployment({
      contractName,
      version,
      network,
      reason: "no usable RPC",
    });
  }

  try {
    const currentCode = await getCode(rpcUrl, address);
    if (currentCode !== "0x") return deployedCell();
  } catch {
    return failedDeployment({
      contractName,
      version,
      network,
      reason: "couldn't get status",
    });
  }

  const assets = loadDeployableAssets({ contractName, version, address });
  if (assets.length === 0) {
    return failedDeployment({
      contractName,
      version,
      network,
      reason: "no local deployable artifact",
    });
  }

  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    return failedDeployment({
      contractName,
      version,
      network,
      reason: "missing MNEMONIC",
    });
  }

  showTransient(`Deploying ${contractName}@${version} to ${network.name}...`);

  const provider = new JsonRpcProvider(rpcUrl, network.chainId, {
    staticNetwork: true,
  });
  const signer = Wallet.fromPhrase(mnemonic, provider);

  try {
    for (const asset of assets) {
      const assetCode = await provider.getCode(asset.bytecode.address);
      if (assetCode !== "0x") continue;

      const factoryCode = await provider.getCode(asset.bytecode.factory);
      if (factoryCode === "0x") {
        throw new Error(`factory ${asset.bytecode.factory} is not deployed`);
      }

      const tx = await signer.sendTransaction({
        to: asset.bytecode.factory,
        data: deploymentData(asset.bytecode),
      });
      await tx.wait();

      const deployedCode = await provider.getCode(asset.bytecode.address);
      if (deployedCode === "0x") {
        throw new Error(`${asset.name} deployment produced no code`);
      }
    }

    const finalCode = await provider.getCode(address);
    if (finalCode === "0x") {
      throw new Error("canonical address is still empty");
    }

    printStatusLine(
      `${color(CHECK, "green")} ${contractName}@${version} deployed to ${
        network.name
      }: ${address}`
    );
    return deployedCell();
  } catch (error) {
    printStatusLine(
      `${color(CROSS, "red")} ${contractName}@${version} failed on ${
        network.name
      }: ${deploymentErrorMessage(error)}`
    );
    return failedCell();
  } finally {
    provider.destroy();
  }
}

async function failedDeployment({
  contractName,
  version,
  network,
  reason,
}: {
  contractName: KnownContracts;
  version: string;
  network: NetworkConfig;
  reason: string;
}): Promise<DeploymentCell> {
  printStatusLine(
    `${color(CROSS, "red")} ${contractName}@${version} failed on ${
      network.name
    }: ${reason}`
  );
  return failedCell();
}

function rpcUrlFor(network: NetworkConfig): string | null {
  if (network.infuraRpcUrl && process.env.INFURA_KEY) {
    return network.infuraRpcUrl;
  }
  return network.publicRpc;
}

function deployedCell(): DeploymentCell {
  return { label: color(CHECK, "green") };
}

function missingCell(): DeploymentCell {
  return { label: color(CROSS, "red") };
}

function errorCell(): DeploymentCell {
  return { label: color(QUESTION, "yellow") };
}

function failedCell(): DeploymentCell {
  return { label: color(CROSS, "red") };
}

function loadDeployableAssets({
  contractName,
  version,
  address,
}: {
  contractName: KnownContracts;
  version: string;
  address: string;
}): DeployableAsset[] {
  const dir = path.join(defaultMastercopiesDir(), contractName, version);
  if (!existsSync(dir)) return [];

  const assets = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const bytecodePath = path.join(dir, entry.name, "bytecode.json");
      if (!existsSync(bytecodePath)) return undefined;

      const bytecode = JSON.parse(
        readFileSync(bytecodePath, "utf8")
      ) as BytecodeFile;
      return { name: entry.name, bytecode };
    })
    .filter((asset): asset is DeployableAsset => asset !== undefined);

  const normalizedAddress = getAddress(address);
  return assets.sort((a, b) => {
    const aIsMain = getAddress(a.bytecode.address) === normalizedAddress;
    const bIsMain = getAddress(b.bytecode.address) === normalizedAddress;
    if (aIsMain === bIsMain) return a.name.localeCompare(b.name);
    return aIsMain ? 1 : -1;
  });
}

function deploymentData(bytecode: BytecodeFile): string {
  const factory = getAddress(bytecode.factory);

  if (factory === getAddress(ERC2470_FACTORY)) {
    return erc2470Interface.encodeFunctionData("deploy", [
      bytecode.creationBytecode,
      bytecode.salt,
    ]);
  }

  if (factory === getAddress(NICK_FACTORY)) {
    return `${bytecode.salt}${bytecode.creationBytecode.slice(2)}`;
  }

  throw new Error(`unsupported singleton factory ${bytecode.factory}`);
}

function deploymentErrorMessage(error: unknown): string {
  if (isInsufficientFundsError(error)) return "insufficient funds";
  return (error as Error)?.message || String(error);
}

function isInsufficientFundsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeError = error as {
    code?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  const message = `${maybeError.message ?? ""} ${
    maybeError.shortMessage ?? ""
  }`.toLowerCase();

  return (
    maybeError.code === "INSUFFICIENT_FUNDS" ||
    message.includes("insufficient funds") ||
    message.includes("not enough funds") ||
    isInsufficientFundsError(maybeError.cause) ||
    isInsufficientFundsError(maybeError.error)
  );
}

function printStatusLine(message: string): void {
  clearProgress();
  console.log(message);
}

function showTransient(message: string): void {
  if (!process.stderr.isTTY) return;
  clearProgress();
  cursorTo(process.stderr, 0);
  process.stderr.write(message);
}

async function getCode(rpcUrl: string, address: string): Promise<string> {
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

function printTable(
  headers: string[],
  rows: { network: string; cells: DeploymentCell[] }[],
  caption: string[]
): void {
  const body = rows.map((row) => [
    row.network,
    ...row.cells.map((c) => c.label),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => visibleLength(row[index])))
  );

  console.log(formatRow(headers, widths));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of body) {
    console.log(formatRow(row, widths));
  }
  console.log();
  console.log(caption.join("  "));
}

function formatRow(row: string[], widths: number[]): string {
  return row
    .map(
      (value, index) => value + " ".repeat(widths[index] - visibleLength(value))
    )
    .join("  ");
}

function visibleLength(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function color(value: string, colorName: "green" | "red" | "yellow"): string {
  const code = colorName === "green" ? 32 : colorName === "red" ? 31 : 33;
  return `\u001b[${code}m${value}\u001b[0m`;
}

function renderProgress(completed: number, total: number): void {
  if (!process.stderr.isTTY) return;
  cursorTo(process.stderr, 0);
  process.stderr.write(`Checking deployments: ${completed}/${total} requests`);
}

function clearProgress(): void {
  if (!process.stderr.isTTY) return;
  cursorTo(process.stderr, 0);
  clearLine(process.stderr, 0);
}
