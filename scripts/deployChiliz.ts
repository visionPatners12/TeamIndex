import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  const Receiver = await ethers.getContractFactory("ChilizDepositReceiver");
  const receiver = await Receiver.deploy(deployer.address);
  await receiver.waitForDeployment();

  const Wrapped = await ethers.getContractFactory("WrappedVaultShare");
  const wrapped = await Wrapped.deploy(
    process.env.CHILIZ_WRAPPED_SHARE_NAME || "TeamIndex Chiliz Wrapped Vault Share",
    process.env.CHILIZ_WRAPPED_SHARE_SYMBOL || "ctiVSHARE",
    deployer.address
  );
  await wrapped.waitForDeployment();

  console.log(JSON.stringify({
    network: "chiliz",
    deployer: deployer.address,
    chilizDepositReceiver: await receiver.getAddress(),
    chilizWrappedShare: await wrapped.getAddress()
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
