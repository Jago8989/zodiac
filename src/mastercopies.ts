import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { cwd } from "process";

import { Asset } from "./types.js";

/**
 * The on-disk layout:
 *
 *   mastercopies/<module>/<version>/<asset>/abi.json
 *   mastercopies/<module>/<version>/<asset>/sourcecode.json
 *   mastercopies/<module>/<version>/<asset>/bytecode.json
 *
 * where <asset> is the main contract name or a linked-library name.
 */
export function defaultMastercopiesDir(): string {
  return path.join(cwd(), "mastercopies");
}

/**
 * Write one asset's three files, creating directories as needed.
 * Returns the asset directory.
 */
export function writeAsset({
  module,
  version,
  asset,
  mastercopiesDir = defaultMastercopiesDir(),
}: {
  module: string;
  version: string;
  asset: Asset;
  mastercopiesDir?: string;
}): string {
  const dir = path.join(mastercopiesDir, module, version, asset.name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, "abi.json"),
    JSON.stringify(asset.abi, null, 2),
    "utf8"
  );
  writeFileSync(
    path.join(dir, "sourcecode.json"),
    JSON.stringify(asset.sourceCode, null, 2),
    "utf8"
  );
  writeFileSync(
    path.join(dir, "bytecode.json"),
    JSON.stringify(asset.bytecode, null, 2),
    "utf8"
  );

  return dir;
}
