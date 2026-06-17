import { clearLine, cursorTo } from "readline";

import { CanonicalAddresses, KnownContracts } from "../src/contracts.js";
import { NetworkConfig, networks } from "../src/networks.js";

interface DeploymentCell {
  label: string;
}

const knownContractNames = Object.values(KnownContracts);
const CHECK = "✓";
const CROSS = "✗";
const QUESTION = "?";

/**
 * CLI entry for `zodiac deploy list <name>`.
 * Prints one row per known network and one column per canonical version.
 */
export async function runDeploy(args: string[]): Promise<void> {
  const [subcommand, name] = args;

  switch (subcommand) {
    case "list": {
      if (!name) {
        throw new Error("Usage: zodiac deploy list <name>");
      }
      await listDeployments(name);
      break;
    }
    case undefined:
      throw new Error("Usage: zodiac deploy list <name>");
    default:
      throw new Error(`Unknown deploy command "${subcommand}".`);
  }
}

async function listDeployments(name: string): Promise<void> {
  const contractName = resolveName(name);
  const versions = CanonicalAddresses[contractName] || {};
  const versionKeys = Object.keys(versions);

  if (versionKeys.length === 0) {
    throw new Error(`No versions on record for ${contractName}.`);
  }

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

  printTable(["network", ...versionKeys], rows);
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
  rows: { network: string; cells: DeploymentCell[] }[]
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
  console.log(
    `${color(CHECK, "green")} deployed  ${color(
      CROSS,
      "red"
    )} not deployed  ${color(QUESTION, "yellow")} couldn't get status`
  );
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
