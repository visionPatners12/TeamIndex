import { ethers } from "hardhat";

/**
 * Polygon deployment:
 *   1. Deploy the `USDC4626Vault` implementation once (locked via `_disableInitializers`).
 *   2. Deploy the `ClubVaultFactory` pointing to that implementation + USDC.
 *      The factory stores `defaultValuator` so every cloned vault is initialized
 *      with the backend wallet allowed to refresh NAV without owner powers.
 *
 * Required env:
 *   POLYGON_USDC_ADDRESS   USDC native on Polygon (0x3c499...3359 for mainnet).
 *   VALUATOR_ADDRESS       Hot backend wallet allowed to call setPoolValuation (typically Railway's).
 *
 * Subsequent `createClubVault` calls on the factory deploy EIP-1167 clones,
 * cutting per-vault gas from ~4M to ~50k.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const asset = process.env.POLYGON_USDC_ADDRESS;
  const valuator = process.env.VALUATOR_ADDRESS;

  if (!asset) throw new Error("POLYGON_USDC_ADDRESS is required");
  if (!valuator) {
    throw new Error(
      "VALUATOR_ADDRESS is required — the backend wallet that calls setPoolValuation. " +
      "Use 0x0000000000000000000000000000000000000000 if you want the deployer to be the only valuator initially."
    );
  }
  if (!ethers.isAddress(valuator)) throw new Error(`Invalid VALUATOR_ADDRESS: ${valuator}`);

  // 1. Implementation — deployed once, never used directly (initializers disabled).
  const Vault = await ethers.getContractFactory("USDC4626Vault");
  const implementation = await Vault.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();

  // 2. Factory wired to the implementation + underlying USDC + default valuator.
  const Factory = await ethers.getContractFactory("ClubVaultFactory");
  const factory = await Factory.deploy(asset, implementationAddress, deployer.address, valuator);
  await factory.waitForDeployment();

  console.log(JSON.stringify({
    network: "polygon",
    deployer: deployer.address,
    usdc4626VaultImplementation: implementationAddress,
    clubVaultFactory: await factory.getAddress(),
    asset,
    defaultValuator: valuator
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
