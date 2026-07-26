import { ethers } from "hardhat";

const POLYMARKET_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

async function main() {
  const [deployer] = await ethers.getSigners();
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

  const Vault = await ethers.getContractFactory("TeamIndexPUSDVaultV2");
  const implementation = await Vault.deploy();
  await implementation.waitForDeployment();

  const Registry = await ethers.getContractFactory("TeamIndexRegistryV2");
  const registry = await Registry.deploy(pUSD, deployer.address);
  await registry.waitForDeployment();

  const Factory = await ethers.getContractFactory("TeamIndexVaultFactoryV2");
  const factory = await Factory.deploy(
    pUSD,
    await implementation.getAddress(),
    await registry.getAddress(),
    deployer.address,
    operator,
    valuator,
  );
  await factory.waitForDeployment();

  const registrarTx = await registry.setRegistrar(await factory.getAddress(), true);
  await registrarTx.wait();

  const Escrow = await ethers.getContractFactory("TeamIndexDepositEscrowV2");
  const escrow = await Escrow.deploy(
    pUSD,
    await registry.getAddress(),
    deployer.address,
    operator,
  );
  await escrow.waitForDeployment();

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
