import { ethers } from "ethers";
import "dotenv/config";

/**
 * Replaces stuck pending transactions with high-gas self-transfers ("cancel" txs).
 *
 * Usage:
 *   STUCK_PRIVATE_KEY=0xYourRailwayKey \
 *   STUCK_RPC_URL=https://polygon-mainnet.infura.io/v3/... \
 *   npx ts-node scripts/unstickMempool.ts
 *
 * The script:
 *   1. Reads the wallet's latest (mined) and pending nonces.
 *   2. For each pending nonce, broadcasts a 0-value self-transfer with high gas
 *      so it replaces the stuck tx (replace-by-fee).
 *   3. Stops after submitting all replacements. They mine one by one.
 *
 * Safety:
 *   - The private key is read from env, not stored.
 *   - Each cancel costs ~21_000 gas (tiny). 169 cancels @ 200 gwei ≈ 0.71 MATIC.
 *   - Replace-by-fee requires the new gas price > old by at least the chain's bump
 *     percentage (12.5% on Polygon). We use a large multiplier to be safe.
 */
async function main() {
  const pk = process.env.STUCK_PRIVATE_KEY;
  // `||` (not `??`) so an accidentally-empty STUCK_RPC_URL falls through to RPC_URL.
  const rpcUrl = process.env.STUCK_RPC_URL || process.env.RPC_URL;
  if (!pk) throw new Error("STUCK_PRIVATE_KEY env var missing");
  if (!rpcUrl) throw new Error("STUCK_RPC_URL (or RPC_URL) env var missing");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const address = await wallet.getAddress();

  const latestNonce = await provider.getTransactionCount(address, "latest");
  const pendingNonce = await provider.getTransactionCount(address, "pending");
  const stuckCount = pendingNonce - latestNonce;

  const balance = await provider.getBalance(address);
  const feeData = await provider.getFeeData();

  // Allow user to override the gas price for cancellations to control cost.
  // Default: 100 gwei maxFee, 50 gwei priority. Higher = more reliable RBF acceptance
  // but more MATIC spent. Override with CANCEL_MAX_FEE_GWEI / CANCEL_PRIORITY_GWEI.
  const networkMaxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("100", "gwei");
  const defaultMaxFeeGwei = Number(ethers.formatUnits(networkMaxFee * 2n, "gwei"));
  const userMaxFeeGwei = process.env.CANCEL_MAX_FEE_GWEI
    ? Number(process.env.CANCEL_MAX_FEE_GWEI)
    : Math.max(defaultMaxFeeGwei, 100);
  const userPriorityGwei = process.env.CANCEL_PRIORITY_GWEI
    ? Number(process.env.CANCEL_PRIORITY_GWEI)
    : Math.max(Math.floor(userMaxFeeGwei / 2), 50);
  const highMaxFeePerGas = ethers.parseUnits(String(userMaxFeeGwei), "gwei");
  const highMaxPriorityFeePerGas = ethers.parseUnits(String(userPriorityGwei), "gwei");

  const perTxCost = highMaxFeePerGas * 21_000n;
  const totalEstCost = perTxCost * BigInt(stuckCount);

  console.log("─── Wallet ───────────────────────────────────────");
  console.log("Address:                ", address);
  console.log("Balance:                ", ethers.formatEther(balance), "MATIC");
  console.log("Latest (mined) nonce:   ", latestNonce);
  console.log("Pending nonce:          ", pendingNonce);
  console.log("Stuck txs to replace:   ", stuckCount);
  console.log();
  console.log("─── Gas plan ─────────────────────────────────────");
  console.log("maxFeePerGas:           ", ethers.formatUnits(highMaxFeePerGas, "gwei"), "gwei");
  console.log("maxPriorityFeePerGas:   ", ethers.formatUnits(highMaxPriorityFeePerGas, "gwei"), "gwei");
  console.log("Cost per cancel (21k):  ", ethers.formatEther(perTxCost), "MATIC");
  console.log("Total estimated cost:   ", ethers.formatEther(totalEstCost), "MATIC");
  console.log();

  if (stuckCount === 0) {
    console.log("✅ No stuck transactions. Nothing to do.");
    return;
  }
  if (totalEstCost > balance) {
    throw new Error(
      `Insufficient balance: have ${ethers.formatEther(balance)} MATIC, need ~${ethers.formatEther(totalEstCost)}. ` +
      `Top up the wallet first.`
    );
  }

  console.log(`Submitting ${stuckCount} replacement txs in nonce order...`);
  console.log();

  // Submit serially in nonce order so RPC accepts them one after another.
  // We don't wait for confirmations — they'll mine over the next few minutes.
  const hashes: string[] = [];
  for (let nonce = latestNonce; nonce < pendingNonce; nonce++) {
    try {
      const tx = await wallet.sendTransaction({
        to: address,        // self
        value: 0n,
        nonce,
        gasLimit: 21_000n,
        maxFeePerGas: highMaxFeePerGas,
        maxPriorityFeePerGas: highMaxPriorityFeePerGas,
        type: 2
      });
      hashes.push(tx.hash);
      if ((nonce - latestNonce) % 10 === 0) {
        console.log(`  nonce ${nonce}: ${tx.hash}`);
      }
    } catch (err: any) {
      console.error(`  nonce ${nonce}: FAILED — ${err.shortMessage ?? err.message ?? err}`);
    }
  }

  console.log();
  console.log(`✅ Submitted ${hashes.length} / ${stuckCount} replacements.`);
  console.log("   They'll mine sequentially over the next 2-5 minutes.");
  console.log();
  console.log("Re-check progress with:");
  console.log("   STUCK_PRIVATE_KEY=... npx ts-node scripts/unstickMempool.ts");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exitCode = 1;
});
