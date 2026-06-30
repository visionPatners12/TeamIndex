import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const asset = process.env.BASE_USDC_ADDRESS;
  const valuator = process.env.VALUATOR_ADDRESS;

  if (!asset) throw new Error("BASE_USDC_ADDRESS is required");
  if (!valuator) throw new Error("VALUATOR_ADDRESS is required");

  const provider = ethers.provider;
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const balance = await provider.getBalance(deployer.address);

  const Vault = await ethers.getContractFactory("USDC4626Vault");
  const vaultTx = await Vault.getDeployTransaction();
  const vaultGas = await provider.estimateGas({ ...vaultTx, from: deployer.address });

  const Factory = await ethers.getContractFactory("ClubVaultFactory");
  const fakeImplementation = "0x0000000000000000000000000000000000000001";
  const factoryTx = await Factory.getDeployTransaction(asset, fakeImplementation, deployer.address, valuator);
  const factoryGas = await provider.estimateGas({ ...factoryTx, from: deployer.address });

  const totalGas = vaultGas + factoryGas;
  const estimatedWei = totalGas * gasPrice;

  console.log(JSON.stringify({
    network: "base",
    deployer: deployer.address,
    balanceEth: ethers.formatEther(balance),
    gasPriceGwei: ethers.formatUnits(gasPrice, "gwei"),
    vaultGas: vaultGas.toString(),
    factoryGas: factoryGas.toString(),
    totalGas: totalGas.toString(),
    estimatedEth: ethers.formatEther(estimatedWei),
    hasEstimatedBalance: balance >= estimatedWei,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
