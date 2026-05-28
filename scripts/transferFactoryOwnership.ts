import { ethers } from "hardhat";

/**
 * Transfers ownership of the ClubVaultFactory to a new address.
 *
 * Usage:
 *   NEW_OWNER=0xE32eB47aaad68dE59A92B8fdE0D0BcC61B7741e3 \
 *   FACTORY_ADDRESS=0x0faD74DB543f446106719735D141Fae6BE523Dda \
 *   npx hardhat run scripts/transferFactoryOwnership.ts --network polygon
 *
 * Run as the CURRENT factory owner (EXECUTOR_PRIVATE_KEY in .env must be that wallet).
 */
async function main() {
  const newOwner = process.env.NEW_OWNER;
  const factoryAddress = process.env.FACTORY_ADDRESS;

  if (!newOwner) throw new Error("NEW_OWNER env var is required");
  if (!factoryAddress) throw new Error("FACTORY_ADDRESS env var is required");
  if (!ethers.isAddress(newOwner)) throw new Error(`Invalid NEW_OWNER address: ${newOwner}`);
  if (!ethers.isAddress(factoryAddress)) throw new Error(`Invalid FACTORY_ADDRESS: ${factoryAddress}`);

  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();

  const factory = await ethers.getContractAt("ClubVaultFactory", factoryAddress);
  const currentOwner = await factory.owner();

  console.log("─────────────────────────────────────────────");
  console.log("Factory:        ", factoryAddress);
  console.log("Current owner:  ", currentOwner);
  console.log("Signer:         ", signerAddress);
  console.log("New owner:      ", newOwner);
  console.log("─────────────────────────────────────────────");

  if (currentOwner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(`Signer is not the current owner. Set EXECUTOR_PRIVATE_KEY to the wallet matching ${currentOwner}.`);
  }
  if (currentOwner.toLowerCase() === newOwner.toLowerCase()) {
    console.log("✅ New owner is already the current owner. Nothing to do.");
    return;
  }

  console.log("Transferring ownership…");
  const tx = await factory.transferOwnership(newOwner);
  console.log("Tx hash:        ", tx.hash);
  const receipt = await tx.wait();
  console.log("Mined in block: ", receipt!.blockNumber);

  const finalOwner = await factory.owner();
  console.log("Final owner:    ", finalOwner);
  if (finalOwner.toLowerCase() !== newOwner.toLowerCase()) {
    throw new Error("Ownership transfer didn't take effect — investigate.");
  }
  console.log("✅ Ownership transferred successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
