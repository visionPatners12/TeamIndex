import { ethers } from "ethers";
import "dotenv/config";

/**
 * Reads the deployer wallet address + MATIC balance from .env without printing
 * the private key. Run with:  npx ts-node scripts/checkDeployerBalance.ts
 */
async function main() {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.EXECUTOR_PRIVATE_KEY;

  if (!rpcUrl) throw new Error("RPC_URL missing in .env");
  if (!pk) throw new Error("EXECUTOR_PRIVATE_KEY missing in .env");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const address = await wallet.getAddress();
  const balance = await provider.getBalance(address);
  const balanceMatic = Number(ethers.formatEther(balance));

  const network = await provider.getNetwork();

  console.log("─────────────────────────────────────────────");
  console.log("Deployer wallet:", address);
  console.log("Network:         ", network.name, `(chainId ${network.chainId})`);
  console.log("MATIC balance:   ", balanceMatic.toFixed(4), "MATIC");
  console.log("─────────────────────────────────────────────");

  if (balanceMatic < 0.5) {
    console.log("⚠️  Less than 0.5 MATIC — top up before deploying.");
    console.log("   Implementation + factory deployment costs ~0.1-0.2 MATIC at typical gwei.");
  } else {
    console.log("✅ Balance OK for deployment.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exitCode = 1;
});
