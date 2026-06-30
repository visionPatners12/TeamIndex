import { ethers } from "hardhat";

/**
 * Base vault/factory redeployment only:
 *   1. Deploy USDC4626Vault implementation.
 *   2. Deploy ClubVaultFactory pointing to that implementation + Base USDC.
 *
 * This intentionally does not redeploy ShareExchange.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const asset = process.env.BASE_USDC_ADDRESS;
  const valuator = process.env.VALUATOR_ADDRESS;

  if (!asset) throw new Error("BASE_USDC_ADDRESS is required");
  if (!valuator) throw new Error("VALUATOR_ADDRESS is required");
  if (!ethers.isAddress(asset)) throw new Error(`Invalid BASE_USDC_ADDRESS: ${asset}`);
  if (!ethers.isAddress(valuator)) throw new Error(`Invalid VALUATOR_ADDRESS: ${valuator}`);

  const Vault = await ethers.getContractFactory("USDC4626Vault");
  const implementation = await Vault.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();

  const Factory = await ethers.getContractFactory("ClubVaultFactory");
  const factory = await Factory.deploy(asset, implementationAddress, deployer.address, valuator);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log(JSON.stringify({
    network: "base",
    deployer: deployer.address,
    usdc4626VaultImplementation: implementationAddress,
    clubVaultFactory: factoryAddress,
    asset,
    defaultValuator: valuator
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
