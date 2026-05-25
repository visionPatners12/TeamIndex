import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const usdc = process.env.BASE_USDC_ADDRESS;
  if (!usdc) throw new Error("BASE_USDC_ADDRESS is required");

  const Receiver = await ethers.getContractFactory("BaseDepositReceiver");
  const receiver = await Receiver.deploy(usdc, deployer.address);
  await receiver.waitForDeployment();

  const Wrapped = await ethers.getContractFactory("WrappedVaultShare");
  const wrapped = await Wrapped.deploy(
    process.env.BASE_WRAPPED_SHARE_NAME || "TeamIndex Wrapped Vault Share",
    process.env.BASE_WRAPPED_SHARE_SYMBOL || "tiVSHARE",
    deployer.address
  );
  await wrapped.waitForDeployment();

  console.log(JSON.stringify({
    network: "base",
    deployer: deployer.address,
    baseDepositReceiver: await receiver.getAddress(),
    baseWrappedShare: await wrapped.getAddress(),
    usdc
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
