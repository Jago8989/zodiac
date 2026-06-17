#!/usr/bin/env node
import { config as loadEnv } from "dotenv";

import { runExtract } from "../commands/extract.js";

loadEnv();

const USAGE = `zodiac — mastercopy artifact tooling

Usage:
  zodiac extract [name] [version] [network] [--force]
      Extract known mastercopies (source, ABI, bytecode) into mastercopies/.
        • no args        -> every known contract + version
        • name           -> every version of that contract
        • name version   -> just that one
      Existing folders are skipped unless --force is given (which removes and
      regenerates them). Addresses come from the canonical registry; source is
      read from [network] or, by default, mainnet then gnosis.

Environment:
  ETHERSCAN_API_KEY[_<NETWORK>]   explorer API key(s)
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "extract": {
      await runExtract(rest);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n✘ ${error?.message || error}`);
  process.exit(1);
});
