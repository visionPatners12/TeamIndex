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
    const [owner, user, operator] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Vault = await ethers.getContractFactory("USDC4626Vault");
    const vault = await Vault.deploy(await usdc.getAddress(), "Club Vault", "cvUSDC", 2_000_000n, owner.address);
    await vault.waitForDeployment();

    await usdc.mint(user.address, 1_000_000n);
    await usdc.connect(user).approve(await vault.getAddress(), 1_000_000n);

    return { owner, user, operator, usdc, vault };
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
});

describe("ClubVaultFactory", function () {
  it("creates one vault per club id", async function () {
    const [owner] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Factory = await ethers.getContractFactory("ClubVaultFactory");
    const factory = await Factory.deploy(await usdc.getAddress(), owner.address);
    await factory.waitForDeployment();

    const clubId = ethers.solidityPackedKeccak256(["string"], ["FC Test"]);
    await factory.createClubVault(clubId, "FC Test Vault", "FCT", 0);
    const vaultAddress = await factory.getVaultByClub(clubId);

    assert.notEqual(vaultAddress, ethers.ZeroAddress);
    await expectRevert(factory.createClubVault(clubId, "FC Test Vault", "FCT", 0), "vault exists");
  });
});
