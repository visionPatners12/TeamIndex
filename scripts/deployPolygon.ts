import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const asset = process.env.POLYGON_USDC_ADDRESS;
  if (!asset) throw new Error("POLYGON_USDC_ADDRESS is required");

  const Factory = await ethers.getContractFactory("ClubVaultFactory");
  const factory = await Factory.deploy(asset, deployer.address);
  await factory.waitForDeployment();

  console.log(JSON.stringify({
    network: "polygon",
    deployer: deployer.address,
    clubVaultFactory: await factory.getAddress(),
    asset
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
