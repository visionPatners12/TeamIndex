import { ethers } from "hardhat";

const OFFICIAL_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  if ((await provider.getNetwork()).chainId !== 137n) throw new Error("Escrow V2 requires Polygon mainnet");

  const registryAddress = process.env.TEAM_INDEX_V2_REGISTRY_ADDRESS;
  const operator = process.env.POLYMARKET_OPERATOR_ADDRESS;
  if (!registryAddress || !ethers.isAddress(registryAddress) || await provider.getCode(registryAddress) === "0x") {
    throw new Error("TEAM_INDEX_V2_REGISTRY_ADDRESS must be the deployed Polygon registry");
  }
  if (!operator || !ethers.isAddress(operator) || operator === ethers.ZeroAddress) {
    throw new Error("POLYMARKET_OPERATOR_ADDRESS is required");
  }
  const registry = await ethers.getContractAt(["function pUSD() view returns(address)"], registryAddress);
  const pUSD = await registry.pUSD() as string;
  if (pUSD.toLowerCase() !== OFFICIAL_PUSD.toLowerCase()) throw new Error("Registry does not use Polygon pUSD");

  const Escrow = await ethers.getContractFactory("TeamIndexDepositEscrowV2");
  const tx = await Escrow.getDeployTransaction(pUSD, registryAddress, deployer.address, operator);
  const gas = await deployer.estimateGas(tx);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPrice) throw new Error("Polygon gas price unavailable");
  const capGwei = process.env.TEAM_INDEX_MAX_DEPLOY_GWEI ?? "60";
  const cap = ethers.parseUnits(capGwei, "gwei");
  const priority = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("25", "gwei");
  const required = gas * cap * 12n / 10n;
  const balance = await provider.getBalance(deployer.address);
  console.log(JSON.stringify({
    stage: "preflight",
    chainId: 137,
    registryAddress,
    deployer: deployer.address,
    operator,
    gasUnits: gas.toString(),
    gasPriceGwei: ethers.formatUnits(gasPrice, "gwei"),
    maxAllowedGasPriceGwei: capGwei,
    requiredPOLWith20PercentBuffer: ethers.formatEther(required),
    balancePOL: ethers.formatEther(balance),
  }));
  if (process.env.TEAM_INDEX_DEPLOY_DRY_RUN === "true") return;
  if (gasPrice > cap || balance < required) throw new Error("Escrow preflight failed; no transaction sent");

  const escrow = await Escrow.deploy(
    pUSD,
    registryAddress,
    deployer.address,
    operator,
    { maxFeePerGas: cap, maxPriorityFeePerGas: priority < cap ? priority : cap },
  );
  await escrow.waitForDeployment();
  console.log(JSON.stringify({
    stage: "escrow",
    chainId: 137,
    address: await escrow.getAddress(),
    registryAddress,
    pUSD,
    txHash: escrow.deploymentTransaction()?.hash,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
