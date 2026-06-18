import { Interface, getAddress, dataSlice, hexlify } from "ethers";

/**
 * Known CREATE2 singleton factories used across the Zodiac ecosystem. Both
 * yield identical addresses on every chain, which is what makes mastercopy
 * replication address-stable.
 */
export const ERC2470_FACTORY = "0xce0042B868300000d44A59004Da54A005ffdcf9f";
export const NICK_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const erc2470Interface = new Interface([
  "function deploy(bytes _initCode, bytes32 _salt) returns (address)",
]);

export interface RecoveredDeployment {
  factory: string;
  initCode: string;
  salt: string;
}

/**
 * Recover the init code and salt from a singleton-factory deployment
 * transaction. Supports the ERC-2470 factory (an abi-encoded `deploy` call)
 * and Nick's factory (raw `salt ++ initCode` calldata).
 *
 * Returns undefined when the transaction does not target a known factory, in
 * which case the deployment cannot be replicated address-stably.
 */
export function recoverDeployment({
  to,
  input,
}: {
  to: string | null;
  input: string;
}): RecoveredDeployment | undefined {
  const factory = to ? getAddress(to) : null;

  if (factory === getAddress(ERC2470_FACTORY)) {
    try {
      const [initCode, salt] = erc2470Interface.decodeFunctionData(
        "deploy",
        input
      );
      return { factory: ERC2470_FACTORY, initCode: hexlify(initCode), salt };
    } catch {
      return undefined;
    }
  }

  if (factory === getAddress(NICK_FACTORY)) {
    // Nick's factory: calldata is salt (32 bytes) followed by the init code.
    const salt = dataSlice(input, 0, 32);
    const initCode = dataSlice(input, 32);
    return { factory: NICK_FACTORY, initCode, salt };
  }

  return undefined;
}
