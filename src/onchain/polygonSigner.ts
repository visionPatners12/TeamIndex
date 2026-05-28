import { ethers, NonceManager } from "ethers";
import type { Env } from "../config/env";

/**
 * Polygon signer singleton with serialized transaction broadcasting.
 *
 * Why this exists:
 *   The backend has multiple subsystems (priceEngine, baseRelayer, vaultExecutor,
 *   polymarket worker, …) that all sign Polygon transactions using the same
 *   EXECUTOR_PRIVATE_KEY. When each subsystem creates its own `new ethers.Wallet`
 *   and fires tx in parallel, two failure modes emerge:
 *
 *     1. Nonce collisions — two concurrent calls fetch the same `pending` nonce
 *        from the RPC, both submit at that nonce, one is rejected.
 *     2. Mempool pile-ups — txs go out faster than they get mined; the queued
 *        cost eventually exceeds the wallet balance and every new tx is rejected
 *        with "insufficient funds for gas * price + value".
 *
 * This module returns a single shared `NonceManager`-wrapped wallet, and exposes
 * `enqueuePolygonTx` to chain submissions on a per-process mutex. Every Polygon
 * tx from any subsystem must go through this chain, guaranteeing that:
 *   • At most one tx is being submitted at a time
 *   • Nonces are tracked locally and increment monotonically
 *   • If a submission throws, the chain doesn't break — next caller proceeds
 */

type SignerBundle = {
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  signer: NonceManager;
  address: string;
};

let cached: SignerBundle | undefined;
let txQueue: Promise<unknown> = Promise.resolve();

function build(env: Env): SignerBundle {
  if (!env.RPC_URL) throw new Error("RPC_URL is required for polygonSigner");
  if (!env.EXECUTOR_PRIVATE_KEY) throw new Error("EXECUTOR_PRIVATE_KEY is required for polygonSigner");

  // batchMaxCount=1 disables JSON-RPC batching, which mainnet Polygon nodes
  // (Infura/Alchemy) sometimes mis-handle on heavy reads.
  const provider = new ethers.JsonRpcProvider(env.RPC_URL, undefined, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(env.EXECUTOR_PRIVATE_KEY, provider);
  const signer = new NonceManager(wallet);
  // Synchronously cache the address for diagnostics.
  let address = "";
  wallet.getAddress().then((a) => (address = a)).catch(() => {});
  return { provider, wallet, signer, address };
}

/** Returns the shared signer + provider. Initializes on first call. */
export function getPolygonSigner(env: Env): SignerBundle {
  if (!cached) cached = build(env);
  return cached;
}

/**
 * Serializes a Polygon-side onchain operation. All callers (priceEngine,
 * baseRelayer, vaultExecutor, …) should wrap their tx-emitting work in this.
 *
 * Usage:
 *   const tx = await enqueuePolygonTx(env, async (signer) => {
 *     const vault = new ethers.Contract(addr, ABI, signer);
 *     return (vault as any).setPoolValuation(pos, pnl);
 *   });
 *   await tx.wait();
 */
export function enqueuePolygonTx<T>(
  env: Env,
  fn: (signer: NonceManager, provider: ethers.JsonRpcProvider) => Promise<T>
): Promise<T> {
  const { signer, provider } = getPolygonSigner(env);
  const next = txQueue
    .catch(() => undefined)
    .then(() => fn(signer, provider));
  // Detach errors from the queue so a single failure doesn't poison subsequent calls.
  txQueue = next.catch(() => undefined);
  return next;
}

/**
 * Force the NonceManager to re-fetch the on-chain pending nonce. Call after a
 * tx submission failure that could have left the local counter out of sync.
 */
export async function resetPolygonNonce(env: Env): Promise<void> {
  const { signer, wallet, provider } = getPolygonSigner(env);
  const address = await wallet.getAddress();
  const pending = await provider.getTransactionCount(address, "pending");
  signer.reset();
  // Setting the nonce by ratcheting it forward to the network's view.
  // ethers v6 NonceManager picks up from provider on next call after reset().
  void pending;
}
