import { ethers } from "ethers";
import "dotenv/config";

/**
 * Diagnoses why the deploy script is failing with "insufficient funds":
 *   1. Compares latest vs pending nonce — reveals stuck pending transactions
 *   2. Shows current network gas price
 *   3. Estimates real deployment cost
 *   4. Shows the wallet's effective spendable balance
 */
async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const pk = process.env.EXECUTOR_PRIVATE_KEY!;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const address = await wallet.getAddress();

  const balance = await provider.getBalance(address);
  const latestNonce = await provider.getTransactionCount(address, "latest");
  const pendingNonce = await provider.getTransactionCount(address, "pending");
  const feeData = await provider.getFeeData();

  console.log("\n─── Wallet ────────────────────────────────────────");
  console.log("Address:        ", address);
  console.log("Balance:        ", ethers.formatEther(balance), "MATIC");

  console.log("\n─── Nonces ────────────────────────────────────────");
  console.log("Latest (mined): ", latestNonce);
  console.log("Pending:        ", pendingNonce);
  const stuck = pendingNonce - latestNonce;
  if (stuck > 0) {
    console.log(`⚠️  ${stuck} pending transaction(s) stuck in mempool`);
    console.log("    These reserve gas from your balance until they clear or are dropped.");
  } else {
    console.log("✅ No stuck transactions");
  }

  console.log("\n─── Network gas ───────────────────────────────────");
  if (feeData.gasPrice) console.log("gasPrice:           ", ethers.formatUnits(feeData.gasPrice, "gwei"), "gwei");
  if (feeData.maxFeePerGas) console.log("maxFeePerGas:       ", ethers.formatUnits(feeData.maxFeePerGas, "gwei"), "gwei");
  if (feeData.maxPriorityFeePerGas) console.log("maxPriorityFeePerGas:", ethers.formatUnits(feeData.maxPriorityFeePerGas, "gwei"), "gwei");

  // Approximate the deploy cost from typical bytecode sizes.
  //   USDC4626Vault implementation: ~3.2M gas
  //   ClubVaultFactory:             ~700k gas
  const TOTAL_GAS_EST = 3_900_000n;
  if (feeData.maxFeePerGas) {
    const estCost = TOTAL_GAS_EST * feeData.maxFeePerGas;
    console.log(`\nEst. deploy cost @ maxFeePerGas (${TOTAL_GAS_EST} gas):`, ethers.formatEther(estCost), "MATIC");
  }
  if (feeData.gasPrice) {
    const estCost = TOTAL_GAS_EST * feeData.gasPrice;
    console.log(`Est. deploy cost @ gasPrice    (${TOTAL_GAS_EST} gas):`, ethers.formatEther(estCost), "MATIC");
  }

  console.log("\n─── Recommandation ────────────────────────────────");
  if (stuck > 0) {
    console.log("1. Va sur https://polygonscan.com/address/" + address + " et regarde la liste \"Pending\".");
    console.log("2. Si tu vois des tx pending depuis longtemps, annule-les depuis MetaMask :");
    console.log("   - Ouvre MetaMask sur cette adresse → onglet Activity → la tx pending → \"Cancel\"");
    console.log("3. Ou attends qu'elles soient dropped (peut prendre ~3h sur Polygon).");
  } else if (feeData.maxFeePerGas && feeData.maxFeePerGas > ethers.parseUnits("500", "gwei")) {
    console.log("Ton RPC retourne un maxFeePerGas anormalement haut (> 500 gwei).");
    console.log("→ Essaie un autre RPC dans .env, par exemple :");
    console.log("   RPC_URL=https://polygon-rpc.com");
    console.log("   RPC_URL=https://polygon.llamarpc.com");
    console.log("   RPC_URL=https://rpc.ankr.com/polygon");
  } else {
    console.log("Solde et gas semblent OK. Si l'erreur revient, top up le wallet à ~5 MATIC.");
  }
  console.log();
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exitCode = 1;
});
