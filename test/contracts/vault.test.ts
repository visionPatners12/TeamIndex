import assert from "node:assert/strict";
import { ethers } from "hardhat";

async function expectRevert(promise: Promise<unknown>, message?: string) {
  try {
    await promise;
  } catch (err: any) {
    if (message) assert.match(String(err?.message ?? err), new RegExp(message));
    return;
  }
  assert.fail("Expected transaction to revert");
}

describe("USDC4626Vault", function () {
  async function fixture() {
    const [owner, user, operator, treasury, valuator] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    // 1. Deploy the implementation once.
    const Vault = await ethers.getContractFactory("USDC4626Vault");
    const implementation = await Vault.deploy();
    await implementation.waitForDeployment();

    // 2. Deploy factory pointing at the implementation, then create a clone.
    const Factory = await ethers.getContractFactory("ClubVaultFactory");
    const factory = await Factory.deploy(
      await usdc.getAddress(),
      await implementation.getAddress(),
      owner.address,
      valuator.address
    );
    await factory.waitForDeployment();

    const clubId = ethers.solidityPackedKeccak256(["string"], ["Test Club"]);
    await factory.createClubVault(clubId, "Club Vault", "cvUSDC", 2_000_000n);
    const vaultAddress = await factory.getVaultByClub(clubId);
    const vault = Vault.attach(vaultAddress);

    await usdc.mint(user.address, 1_000_000n);
    await usdc.connect(user).approve(vaultAddress, 1_000_000n);

    return { owner, user, operator, treasury, valuator, usdc, vault, factory, implementation };
  }

  it("accepts ERC4626 deposits and tracks cash/assets", async function () {
    const { user, vault } = await fixture();

    await vault.connect(user).deposit(500_000n, user.address);

    assert.equal((await vault.totalCash()).toString(), "500000");
    assert.equal((await vault.totalAssets()).toString(), "500000");
    assert.equal((await vault.balanceOf(user.address)).toString(), "500000");
  });

  it("enforces pause and deposit cap", async function () {
    const { owner, user, vault } = await fixture();

    await expectRevert(vault.connect(user).deposit(2_000_001n, user.address), "ERC4626ExceededMaxDeposit");

    await vault.connect(owner).pause();
    await expectRevert(vault.connect(user).deposit(1n, user.address), "EnforcedPause");
  });

  it("authorizes operators for whitelisted calls", async function () {
    const { owner, operator, usdc, vault } = await fixture();
    const usdcAddress = await usdc.getAddress();
    const vaultAddress = await vault.getAddress();

    await vault.connect(owner).addAuthorizedOperator(operator.address, 0, 0);
    await vault.connect(owner).addWhitelistedContract(usdcAddress);

    const data = usdc.interface.encodeFunctionData("approve", [operator.address, 123n]);
    await vault.connect(operator).executeWhitelistedCall(usdcAddress, data, 0, 0, 0, false);

    assert.equal((await usdc.allowance(vaultAddress, operator.address)).toString(), "123");
  });

  it("rejects non-whitelisted targets", async function () {
    const { owner, operator, usdc, vault } = await fixture();
    const data = usdc.interface.encodeFunctionData("approve", [operator.address, 123n]);
    await vault.connect(owner).addAuthorizedOperator(operator.address, 0, 0);

    await expectRevert(
      vault.connect(operator).executeWhitelistedCall(await usdc.getAddress(), data, 0, 0, 0, false),
      "target not whitelisted"
    );
  });

  it("resets operator allocation so they aren't blocked forever", async function () {
    const { owner, operator, usdc, vault } = await fixture();
    const usdcAddress = await usdc.getAddress();

    await vault.connect(owner).addAuthorizedOperator(operator.address, 1_000n, 0);
    await vault.connect(owner).addWhitelistedContract(usdcAddress);

    const data = usdc.interface.encodeFunctionData("approve", [operator.address, 0n]);
    // Use up the full allocation.
    await vault.connect(operator).executeWhitelistedCall(usdcAddress, data, 0, 1_000n, 0, false);

    // Next call exceeds → revert.
    await expectRevert(
      vault.connect(operator).executeWhitelistedCall(usdcAddress, data, 0, 1n, 0, false),
      "allocation exceeded"
    );

    // Reset and try again — should pass.
    await vault.connect(owner).resetOperatorAllocation(operator.address);
    await vault.connect(operator).executeWhitelistedCall(usdcAddress, data, 0, 1n, 0, false);

    const [, , currentAlloc] = await vault.getOperatorInfo(operator.address);
    assert.equal(currentAlloc.toString(), "1");
  });

  it("represents losses with a signed realizedPnl", async function () {
    const { owner, user, vault } = await fixture();
    await vault.connect(user).deposit(500_000n, user.address);

    // Simulate a 100k loss on closed positions.
    await vault.connect(owner).setPoolValuation(0n, -100_000n);
    assert.equal((await vault.totalAssets()).toString(), "400000");
    assert.equal((await vault.realizedPnl()).toString(), "-100000");
  });

  it("allows the valuator (not just owner) to update NAV", async function () {
    const { owner, user, valuator, vault } = await fixture();
    await vault.connect(user).deposit(500_000n, user.address);

    // Default valuator is wired in by the factory.
    assert.equal(await vault.valuator(), valuator.address);

    // Valuator can update NAV without holding any other admin powers.
    await vault.connect(valuator).setPoolValuation(0n, 50_000n);
    assert.equal((await vault.totalAssets()).toString(), "550000");

    // Random wallets cannot.
    await expectRevert(vault.connect(user).setPoolValuation(0n, 999_999n));

    // Owner can rotate the valuator.
    await vault.connect(owner).setValuator(ethers.ZeroAddress);
    await expectRevert(vault.connect(valuator).setPoolValuation(0n, 0n));
  });

  it("charges entry fees and emits VaultFeeCharged", async function () {
    const { owner, user, treasury, vault, usdc } = await fixture();
    // 1% entry fee.
    await vault.connect(owner).setFeeConfig(100n, 0n, treasury.address);

    const tx = await vault.connect(user).deposit(100_000n, user.address);
    const receipt = await tx.wait();

    const feeLog = receipt!.logs
      .map((l: any) => {
        try { return vault.interface.parseLog(l); } catch { return null; }
      })
      .find((p: any) => p && p.name === "VaultFeeCharged");

    assert.ok(feeLog, "VaultFeeCharged event missing");
    assert.equal(feeLog.args.treasury, treasury.address);
    // _feeOnTotal(100_000, 100bps) = ceil(100_000 * 100 / 10_100) = 991.
    assert.equal(feeLog.args.feeAssets.toString(), "991");
    assert.equal(feeLog.args.grossAssets.toString(), "100000");
    assert.equal(feeLog.args.netAssets.toString(), String(100_000n - 991n));
    assert.equal((await usdc.balanceOf(treasury.address)).toString(), "991");
  });

  it("cannot rescue the underlying asset", async function () {
    const { owner, user, usdc, vault } = await fixture();
    await vault.connect(user).deposit(500_000n, user.address);
    await expectRevert(vault.connect(owner).rescueTokens(await usdc.getAddress(), 1n), "cannot rescue underlying");
  });

  it("rejects fee config above the hard cap", async function () {
    const { owner, treasury, vault } = await fixture();
    await expectRevert(vault.connect(owner).setFeeConfig(501n, 0n, treasury.address), "entry fee too high");
    await expectRevert(vault.connect(owner).setFeeConfig(0n, 501n, treasury.address), "exit fee too high");
  });
});

describe("ClubVaultFactory (Clones)", function () {
  it("creates one clone per club id and refuses duplicates", async function () {
    const [owner, valuator] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Vault = await ethers.getContractFactory("USDC4626Vault");
    const implementation = await Vault.deploy();
    await implementation.waitForDeployment();

    const Factory = await ethers.getContractFactory("ClubVaultFactory");
    const factory = await Factory.deploy(
      await usdc.getAddress(),
      await implementation.getAddress(),
      owner.address,
      valuator.address
    );
    await factory.waitForDeployment();

    const clubId = ethers.solidityPackedKeccak256(["string"], ["FC Test"]);

    // Address is deterministic — confirm before deploying.
    const predicted = await factory.predictVaultAddress(clubId);

    await factory.createClubVault(clubId, "FC Test Vault", "FCT", 0);
    const vaultAddress = await factory.getVaultByClub(clubId);

    assert.equal(vaultAddress.toLowerCase(), predicted.toLowerCase());
    assert.notEqual(vaultAddress, ethers.ZeroAddress);

    // The freshly-cloned vault should already have the factory's defaultValuator wired in.
    const Vault2 = await ethers.getContractFactory("USDC4626Vault");
    const vault = Vault2.attach(vaultAddress);
    assert.equal(await vault.valuator(), valuator.address);

    await expectRevert(factory.createClubVault(clubId, "FC Test Vault", "FCT", 0), "vault exists");
  });

  it("locks the implementation against direct initialization", async function () {
    const [owner, valuator] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Vault = await ethers.getContractFactory("USDC4626Vault");
    const implementation = await Vault.deploy();
    await implementation.waitForDeployment();

    // The implementation has `_disableInitializers()` in its constructor.
    // OZ 5 reverts with the custom error `InvalidInitialization()` whose 4-byte selector is 0xf92ee8a9.
    await expectRevert(
      implementation.initialize(await usdc.getAddress(), "Bad", "BAD", 0, owner.address, valuator.address),
      "0xf92ee8a9"
    );
  });
});
