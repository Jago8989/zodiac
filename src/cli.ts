#!/usr/bin/env node
import "dotenv/config";

import { runDeploy } from "../commands/deploy.js";
import { runExtract } from "../commands/extract.js";

const USAGE = `zodiac — mastercopy artifact tooling

Usage:
  zodiac deploy list <name>
      Check whether each canonical version of a known contract is already
      deployed on each configured network.

  zodiac extract [name] [version] [network] [--force]
      Extract known mastercopies (source, ABI, bytecode) into mastercopies/.
        • no args        -> every known contract + version
        • name           -> every version of that contract
        • name version   -> just that one
      Existing folders are skipped unless --force is given (which removes and
      regenerates them). Addresses come from the canonical registry; source is
      read from [network] or, by default, the default explorer set.

Environment:
  INFURA_KEY                      enables Infura RPC endpoints
  ETHERSCAN_API_KEY[_<NETWORK>]   explorer API key(s)
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "deploy": {
      await runDeploy(rest);
      break;
    }
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
