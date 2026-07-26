import assert from "node:assert/strict";
import { ethers } from "hardhat";

async function expectRevert(promise: Promise<unknown>, message?: string) {
  try {
    await promise;
  } catch (error: any) {
    if (message) assert.match(String(error?.message ?? error), new RegExp(message));
    return;
  }
  assert.fail("Expected transaction to revert");
}

describe("TeamIndex Polygon pUSD vault V2", function () {
  async function fixture() {
    const [owner, user, operator, valuator, depositWallet, depositWalletOwner, receiver] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const pUSD = await MockERC20.deploy("Polymarket USD", "pUSD", 6);
    await pUSD.waitForDeployment();

    const Vault = await ethers.getContractFactory("TeamIndexPUSDVaultV2");
    const implementation = await Vault.deploy();
    await implementation.waitForDeployment();

    const Registry = await ethers.getContractFactory("TeamIndexRegistryV2");
    const registry = await Registry.deploy(await pUSD.getAddress(), owner.address);
    await registry.waitForDeployment();

    const Factory = await ethers.getContractFactory("TeamIndexVaultFactoryV2");
    const factory = await Factory.deploy(
      await pUSD.getAddress(),
      await implementation.getAddress(),
      await registry.getAddress(),
      owner.address,
      operator.address,
      valuator.address,
    );
    await factory.waitForDeployment();
    await registry.setRegistrar(await factory.getAddress(), true);

    const poolId = ethers.keccak256(ethers.toUtf8Bytes("team-index:pool:test"));
    await factory.createPoolVault(
      poolId,
      "TeamIndex Test",
      "tiPUSD",
      2_000_000n,
      depositWallet.address,
      depositWalletOwner.address,
    );
    const vaultAddress = await factory.getVaultByPool(poolId);
    const vault = Vault.attach(vaultAddress);

    await pUSD.mint(user.address, 2_000_000n);
    await pUSD.connect(user).approve(vaultAddress, 2_000_000n);

    return {
      owner,
      user,
      operator,
      valuator,
      depositWallet,
      depositWalletOwner,
      receiver,
      pUSD,
      vault,
      vaultAddress,
      factory,
      registry,
      poolId,
    };
  }

  it("registers a one-to-one vault and Deposit Wallet", async function () {
    const { registry, poolId, vaultAddress, depositWallet, depositWalletOwner } = await fixture();
    const account = await registry.pools(poolId);
    assert.equal(account.vault, vaultAddress);
    assert.equal(account.depositWallet, depositWallet.address);
    assert.equal(account.depositWalletOwner, depositWalletOwner.address);
    assert.equal(account.active, true);
    assert.equal(await registry.poolByDepositWallet(depositWallet.address), poolId);
  });

  it("accepts pUSD and allocates only an owner-approved proposal", async function () {
    const { owner, user, operator, depositWallet, pUSD, vault } = await fixture();
    await vault.connect(user).deposit(1_000_000n, user.address);

    const proposalHash = ethers.keccak256(ethers.toUtf8Bytes("proposal:1"));
    await expectRevert(
      vault.connect(operator).allocateToDepositWallet(100_000n, proposalHash),
      "ProposalNotActive",
    );

    await vault.connect(owner).activateProposal(proposalHash, 300_000n);
    await vault.connect(operator).allocateToDepositWallet(300_000n, proposalHash);

    assert.equal(await pUSD.balanceOf(depositWallet.address), 300_000n);
    assert.equal(await vault.totalCash(), 700_000n);
    assert.equal(await vault.externalAssetsValue(), 300_000n);
    assert.equal(await vault.totalAssets(), 1_000_000n);
    assert.equal(await vault.proposalRemaining(proposalHash), 0n);
  });

  it("enforces the 30% operational cap and 20% idle reserve", async function () {
    const { owner, user, operator, vault } = await fixture();
    await vault.connect(user).deposit(1_000_000n, user.address);
    const proposalHash = ethers.keccak256(ethers.toUtf8Bytes("proposal:limits"));
    await vault.connect(owner).activateProposal(proposalHash, 400_000n);
    await expectRevert(
      vault.connect(operator).allocateToDepositWallet(400_000n, proposalHash),
      "ExternalAllocationExceeded",
    );
  });

  it("recognizes returned capital without double counting profit", async function () {
    const { owner, user, operator, depositWallet, pUSD, vault, vaultAddress } = await fixture();
    await vault.connect(user).deposit(1_000_000n, user.address);
    const proposalHash = ethers.keccak256(ethers.toUtf8Bytes("proposal:return"));
    await vault.connect(owner).activateProposal(proposalHash, 300_000n);
    await vault.connect(operator).allocateToDepositWallet(300_000n, proposalHash);

    await pUSD.mint(depositWallet.address, 20_000n);
    await pUSD.connect(depositWallet).transfer(vaultAddress, 320_000n);
    await vault.syncReturnedCapital();

    assert.equal(await vault.externalAssetsValue(), 0n);
    assert.equal(await vault.externalCapitalOutstanding(), 0n);
    assert.equal(await vault.totalAssets(), 1_020_000n);
  });

  it("accepts monotone accounting attestations and blocks stale deposits", async function () {
    const { owner, user, operator, valuator, vault } = await fixture();
    await vault.connect(user).deposit(1_000_000n, user.address);
    const proposalHash = ethers.keccak256(ethers.toUtf8Bytes("proposal:valuation"));
    await vault.connect(owner).activateProposal(proposalHash, 300_000n);
    await vault.connect(operator).allocateToDepositWallet(300_000n, proposalHash);

    const block = await ethers.provider.getBlock("latest");
    const snapshotHash = ethers.keccak256(ethers.toUtf8Bytes("snapshot:1"));
    await vault
      .connect(valuator)
      .recordExternalValuation(1n, 310_000n, 50_000n, BigInt(block!.timestamp), snapshotHash);
    assert.equal(await vault.totalAssets(), 1_010_000n);

    await expectRevert(
      vault
        .connect(valuator)
        .recordExternalValuation(1n, 1n, 0n, BigInt(block!.timestamp), snapshotHash),
      "InvalidValuation",
    );

    await ethers.provider.send("evm_increaseTime", [901]);
    await ethers.provider.send("evm_mine", []);
    assert.equal(await vault.maxDeposit(user.address), 0n);
    await expectRevert(vault.connect(user).deposit(1n, user.address));
  });

  it("queues a redemption until enough idle pUSD is available", async function () {
    const { owner, user, operator, depositWallet, receiver, pUSD, vault, vaultAddress } = await fixture();
    await vault.connect(user).deposit(1_000_000n, user.address);
    const proposalHash = ethers.keccak256(ethers.toUtf8Bytes("proposal:redeem"));
    await vault.connect(owner).activateProposal(proposalHash, 300_000n);
    await vault.connect(operator).allocateToDepositWallet(300_000n, proposalHash);

    await vault.connect(user).requestRedeem(800_000n, receiver.address, user.address, 790_000n);
    await expectRevert(vault.connect(operator).makeRedemptionClaimable(1n), "InsufficientIdleCash");

    await pUSD.connect(depositWallet).transfer(vaultAddress, 300_000n);
    await vault.syncReturnedCapital();
    await vault.connect(operator).makeRedemptionClaimable(1n);
    assert.equal(await vault.pendingClaimableAssets(), 800_000n);

    await vault.claimRedemption(1n);
    assert.equal(await pUSD.balanceOf(receiver.address), 800_000n);
    assert.equal(await vault.pendingClaimableAssets(), 0n);
    const request = await vault.redemptionRequests(1n);
    assert.equal(request.state, 3n);
  });

  it("has no generic call or ERC-1271 order signing surface", async function () {
    const { vault } = await fixture();
    assert.equal(vault.interface.hasFunction("executeWhitelistedCall"), false);
    assert.equal(vault.interface.hasFunction("isValidSignature"), false);
    assert.equal(vault.interface.hasFunction("setDepositWallet"), false);
  });

  it("settles the pUSD-transfer fallback through the registered-vault escrow", async function () {
    const { owner, user, operator, pUSD, registry, vault, vaultAddress } = await fixture();
    const Escrow = await ethers.getContractFactory("TeamIndexDepositEscrowV2");
    const escrow = await Escrow.deploy(
      await pUSD.getAddress(),
      await registry.getAddress(),
      owner.address,
      operator.address,
    );
    await escrow.waitForDeployment();
    await pUSD.mint(await escrow.getAddress(), 100_000n);

    const intentId = ethers.keccak256(ethers.toUtf8Bytes("deposit-intent:1"));
    await escrow.connect(operator).settle(intentId, vaultAddress, user.address, 100_000n);
    assert.equal(await vault.balanceOf(user.address), 100_000n);
    assert.equal(await pUSD.balanceOf(vaultAddress), 100_000n);
    await expectRevert(
      escrow.connect(operator).settle(intentId, vaultAddress, user.address, 100_000n),
      "InvalidIntent",
    );
  });
});
