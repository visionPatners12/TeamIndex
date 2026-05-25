import { ethers } from "ethers";

export const MANUAL_RECONCILIATION_STATUS = "NEEDS_MANUAL_RECONCILIATION" as const;

const ERC4626_DEPOSIT_INTERFACE = new ethers.Interface([
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
]);

export function truncateRelayerError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export function relayerLockStaleBefore(prefix: "BASE" | "CHILIZ") {
  const ms = Number(process.env[`${prefix}_RELAYER_LOCK_TIMEOUT_MS`] || process.env.RELAYER_LOCK_TIMEOUT_MS || 15 * 60 * 1000);
  return new Date(Date.now() - ms);
}

export function parseVaultSharesFromReceipt(receipt: ethers.TransactionReceipt | null) {
  if (!receipt) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = ERC4626_DEPOSIT_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "Deposit") {
        return BigInt(parsed.args.shares.toString());
      }
    } catch {
      // Ignore unrelated logs from other contracts in the same transaction.
    }
  }
  return null;
}

export async function requireSuccessfulReceipt(
  provider: ethers.Provider,
  txHash: string,
  label: string
) {
  const receipt = await provider.waitForTransaction(txHash, 1);
  if (!receipt) throw new Error(`${label} transaction receipt not found`);
  if (receipt.status === 0) throw new Error(`${label} transaction reverted: ${txHash}`);
  return receipt;
}

export function decimalToBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const [whole, fraction = ""] = value.split(".");
    if (fraction.replace(/0/g, "").length > 0) {
      throw new Error(`Cannot convert fractional decimal value to bigint: ${value}`);
    }
    return BigInt(whole || "0");
  }
  if (value && typeof (value as any).toString === "function") return decimalToBigInt((value as any).toString());
  throw new Error("Cannot convert empty decimal value to bigint");
}
