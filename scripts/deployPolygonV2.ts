import { ethers } from "hardhat";

const POLYMARKET_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== 137n) throw new Error("TeamIndex V2 must deploy on Polygon mainnet (chain 137)");
  const pUSD = process.env.POLY_PUSD_ADDRESS || POLYMARKET_PUSD;
  const operator = process.env.POLYMARKET_OPERATOR_ADDRESS;
  const valuator = process.env.POLYMARKET_VALUATOR_ADDRESS;

  if (!ethers.isAddress(pUSD)) throw new Error(`Invalid POLY_PUSD_ADDRESS: ${pUSD}`);
  if (!operator || !ethers.isAddress(operator)) {
    throw new Error("POLYMARKET_OPERATOR_ADDRESS is required");
  }
  if (!valuator || !ethers.isAddress(valuator)) {
    throw new Error("POLYMARKET_VALUATOR_ADDRESS is required");
  }
  if (pUSD.toLowerCase() !== POLYMARKET_PUSD.toLowerCase()) {
    throw new Error("Polygon mainnet deployment requires the official Polymarket pUSD address");
  }
  if (operator === ethers.ZeroAddress || valuator === ethers.ZeroAddress) {
    throw new Error("Operator and valuator cannot be the zero address");
  }
  if (await provider.getCode(pUSD) === "0x") throw new Error("pUSD has no Polygon contract code");
  const pUSDToken = await ethers.getContractAt(["function decimals() view returns (uint8)"], pUSD);
  if (Number(await pUSDToken.decimals()) !== 6) throw new Error("pUSD must have 6 decimals");

  const Vault = await ethers.getContractFactory("TeamIndexPUSDVaultV2");
  const Registry = await ethers.getContractFactory("TeamIndexRegistryV2");
  const Factory = await ethers.getContractFactory("TeamIndexVaultFactoryV2");
  const Escrow = await ethers.getContractFactory("TeamIndexDepositEscrowV2");

  // Check the whole deployment budget before the first irreversible transaction.
  // Placeholder constructor addresses have the same calldata size as the final ones.
  const deploymentTxs = await Promise.all([
    Vault.getDeployTransaction(),
    Registry.getDeployTransaction(pUSD, deployer.address),
    Factory.getDeployTransaction(pUSD, deployer.address, deployer.address, deployer.address, operator, valuator),
    Escrow.getDeployTransaction(pUSD, deployer.address, deployer.address, operator),
  ]);
  const deploymentGas = await Promise.all(deploymentTxs.map((tx) => deployer.estimateGas(tx)));
  if (deploymentGas.some((gas) => gas <= 21_000n)) {
    throw new Error("Invalid contract deployment gas estimate; no transaction was sent");
  }
  const feeData = await provider.getFeeData();
  const currentGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!currentGasPrice) throw new Error("Could not estimate Polygon gas price");
  const maxDeployGwei = process.env.TEAM_INDEX_MAX_DEPLOY_GWEI ?? "60";
  const maxDeployFee = ethers.parseUnits(maxDeployGwei, "gwei");
  if (maxDeployFee <= 0n) throw new Error("TEAM_INDEX_MAX_DEPLOY_GWEI must be positive");
  const priorityFee = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("25", "gwei");
  const txFees = {
    maxFeePerGas: maxDeployFee,
    maxPriorityFeePerGas: priorityFee < maxDeployFee ? priorityFee : maxDeployFee,
  };
  const estimatedGas = deploymentGas.reduce((total, gas) => total + gas, 100_000n);
  // The balance check uses the same maximum fee imposed on every transaction.
  const requiredWei = estimatedGas * maxDeployFee * 12n / 10n;
  const balanceWei = await provider.getBalance(deployer.address);
  console.log(JSON.stringify({
    stage: "preflight",
    chainId: 137,
    deployer: deployer.address,
    operator,
    valuator,
    balancePOL: ethers.formatEther(balanceWei),
    currentGasPriceGwei: ethers.formatUnits(currentGasPrice, "gwei"),
    maxAllowedGasPriceGwei: maxDeployGwei,
    estimatedGasUnits: estimatedGas.toString(),
    estimatedCostPOLAtCurrentGasPrice: ethers.formatEther(estimatedGas * currentGasPrice),
    requiredPOLWith20PercentBuffer: ethers.formatEther(requiredWei),
  }));
  if (process.env.TEAM_INDEX_DEPLOY_DRY_RUN === "true") return;
  if (currentGasPrice > maxDeployFee) {
    throw new Error("Polygon gas price exceeds TEAM_INDEX_MAX_DEPLOY_GWEI; no transaction was sent");
  }
  if (balanceWei < requiredWei) {
    throw new Error("Insufficient POL for complete V2 deployment; no transaction was sent");
  }

  const implementation = await Vault.deploy(txFees);
  await implementation.waitForDeployment();
  console.log(JSON.stringify({ stage: "vault-implementation", address: await implementation.getAddress(), txHash: implementation.deploymentTransaction()?.hash }));

  const registry = await Registry.deploy(pUSD, deployer.address, txFees);
  await registry.waitForDeployment();
  console.log(JSON.stringify({ stage: "registry", address: await registry.getAddress(), txHash: registry.deploymentTransaction()?.hash }));

  const factory = await Factory.deploy(
    pUSD,
    await implementation.getAddress(),
    await registry.getAddress(),
    deployer.address,
    operator,
    valuator,
    txFees,
  );
  await factory.waitForDeployment();
  console.log(JSON.stringify({ stage: "factory", address: await factory.getAddress(), txHash: factory.deploymentTransaction()?.hash }));

  const registrarTx = await registry.setRegistrar(await factory.getAddress(), true, txFees);
  await registrarTx.wait();
  console.log(JSON.stringify({ stage: "registrar", txHash: registrarTx.hash }));

  const escrow = await Escrow.deploy(
    pUSD,
    await registry.getAddress(),
    deployer.address,
    operator,
    txFees,
  );
  await escrow.waitForDeployment();
  console.log(JSON.stringify({ stage: "escrow", address: await escrow.getAddress(), txHash: escrow.deploymentTransaction()?.hash }));

  console.log(
    JSON.stringify(
      {
        network: "polygon",
        chainId: 137,
        deployer: deployer.address,
        pUSD,
        teamIndexPUSDVaultV2Implementation: await implementation.getAddress(),
        teamIndexRegistryV2: await registry.getAddress(),
        teamIndexVaultFactoryV2: await factory.getAddress(),
        teamIndexDepositEscrowV2: await escrow.getAddress(),
        operator,
        valuator,
        defaults: {
          operationalExternalAllocationBps: 3000,
          minIdleReserveBps: 2000,
          maxValuationAgeSeconds: 900,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
