import { compare, satisfies, valid } from "semver";

import { ABIs } from "./abis/index.js";
import { KnownContracts } from "./contracts.js";

type VersionedAbis = Record<string, readonly unknown[]>;

export function getZodiacModuleAbi(
  name: KnownContracts,
  versionRange = "*"
): readonly unknown[] {
  const versions = (ABIs as Partial<Record<KnownContracts, VersionedAbis>>)[
    name
  ];

  if (!versions) {
    throw new Error(`No ABI registry for ${name}`);
  }

  const version = Object.keys(versions)
    .sort(compare)
    .reverse()
    .find((entry) =>
      satisfies(entry, valid(versionRange) ? `=${versionRange}` : versionRange)
    );

  if (!version) {
    throw new Error(`No ABI for ${name}@${versionRange}`);
  }

  return versions[version];
}
