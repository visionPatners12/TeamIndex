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

describe("BaseDepositReceiver", function () {
  async function fixture() {
    const [owner, user, relayer] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Receiver = await ethers.getContractFactory("BaseDepositReceiver");
    const receiver = await Receiver.deploy(await usdc.getAddress(), owner.address);
    await receiver.waitForDeployment();

    await usdc.mint(user.address, 1_000_000n);
    await usdc.connect(user).approve(await receiver.getAddress(), 1_000_000n);
    await receiver.connect(owner).setRelayer(relayer.address, true);

    return { owner, user, relayer, usdc, receiver };
  }

  it("stores USDC deposits and releases them once to the relayer", async function () {
    const { user, relayer, usdc, receiver } = await fixture();
    const poolId = ethers.solidityPackedKeccak256(["string"], ["FC Base"]);

    await receiver.connect(user).depositUSDC(250_000n, poolId);
    const deposit = await receiver.deposits(1);

    assert.equal(deposit.user, user.address);
    assert.equal(deposit.amount.toString(), "250000");
    assert.equal(deposit.poolId, poolId);

    await receiver.connect(relayer).releaseDeposit(1, relayer.address);
    assert.equal((await usdc.balanceOf(relayer.address)).toString(), "250000");

    await expectRevert(receiver.connect(relayer).releaseDeposit(1, relayer.address), "already released");
  });
});

describe("WrappedVaultShare", function () {
  it("allows authorized mint and burn", async function () {
    const [owner, user, minter] = await ethers.getSigners();
    const Wrapped = await ethers.getContractFactory("WrappedVaultShare");
    const wrapped = await Wrapped.deploy("Wrapped Club Share", "wCLUB", owner.address);
    await wrapped.waitForDeployment();

    const depositId = ethers.zeroPadValue("0x01", 32);
    const redemptionId = ethers.zeroPadValue("0x02", 32);

    await wrapped.connect(owner).setMinter(minter.address, true);
    await wrapped.connect(minter).mint(user.address, 1_000_000_000_000_000_000n, depositId);
    assert.equal((await wrapped.balanceOf(user.address)).toString(), "1000000000000000000");

    await wrapped.connect(minter).burn(user.address, 500_000_000_000_000_000n, redemptionId);
    assert.equal((await wrapped.balanceOf(user.address)).toString(), "500000000000000000");
  });
});
