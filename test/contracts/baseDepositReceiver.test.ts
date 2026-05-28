import assert from "node:assert/strict";
import { ethers, network } from "hardhat";

async function expectRevert(promise: Promise<unknown>, message?: string) {
  try {
    await promise;
  } catch (err: any) {
    if (message) assert.match(String(err?.message ?? err), new RegExp(message));
    return;
  }
  assert.fail("Expected transaction to revert");
}

async function advanceTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("BaseDepositReceiver", function () {
  async function fixture() {
    const [owner, user, relayer, stranger] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Receiver = await ethers.getContractFactory("BaseDepositReceiver");
    const receiver = await Receiver.deploy(await usdc.getAddress(), owner.address);
    await receiver.waitForDeployment();

    await usdc.mint(user.address, 1_000_000n);
    await usdc.connect(user).approve(await receiver.getAddress(), 1_000_000n);
    await receiver.connect(owner).setRelayer(relayer.address, true);

    return { owner, user, relayer, stranger, usdc, receiver };
  }

  it("stores USDC deposits and releases them once to the relayer", async function () {
    const { user, relayer, usdc, receiver } = await fixture();
    const poolId = ethers.solidityPackedKeccak256(["string"], ["FC Base"]);

    await receiver.connect(user).depositUSDC(250_000n, poolId);
    const deposit = await receiver.deposits(1);

    assert.equal(deposit.user, user.address);
    assert.equal(deposit.amount.toString(), "250000");
    assert.equal(deposit.poolId, poolId);
    assert.equal(deposit.released, false);
    assert.equal(deposit.refunded, false);
    assert.equal((await receiver.totalLockedUsdc()).toString(), "250000");

    await receiver.connect(relayer).releaseDeposit(1, relayer.address);
    assert.equal((await usdc.balanceOf(relayer.address)).toString(), "250000");
    assert.equal((await receiver.totalLockedUsdc()).toString(), "0");

    await expectRevert(receiver.connect(relayer).releaseDeposit(1, relayer.address), "already released");
  });

  it("lets the depositor refund after the window elapses", async function () {
    const { user, receiver, usdc } = await fixture();
    const poolId = ethers.solidityPackedKeccak256(["string"], ["FC Base"]);

    await receiver.connect(user).depositUSDC(100_000n, poolId);
    const balanceBefore = await usdc.balanceOf(user.address);

    await expectRevert(receiver.connect(user).refundDeposit(1), "refund window not elapsed");

    await advanceTime(24 * 60 * 60 + 1);

    await receiver.connect(user).refundDeposit(1);
    const balanceAfter = await usdc.balanceOf(user.address);
    assert.equal((balanceAfter - balanceBefore).toString(), "100000");
    assert.equal((await receiver.totalLockedUsdc()).toString(), "0");
  });

  it("refunds work even when the contract is paused", async function () {
    const { owner, user, receiver } = await fixture();
    const poolId = ethers.solidityPackedKeccak256(["string"], ["FC Base"]);

    await receiver.connect(user).depositUSDC(50_000n, poolId);
    await receiver.connect(owner).pause();
    await advanceTime(24 * 60 * 60 + 1);

    // refundDeposit must NOT be gated by whenNotPaused.
    await receiver.connect(user).refundDeposit(1);
  });

  it("blocks rescue of USDC that backs live deposits", async function () {
    const { owner, user, receiver, usdc } = await fixture();
    const poolId = ethers.solidityPackedKeccak256(["string"], ["FC Base"]);

    await receiver.connect(user).depositUSDC(100_000n, poolId);
    // Try to rescue more than the unallocated balance (0).
    await expectRevert(
      receiver.connect(owner).rescueTokens(await usdc.getAddress(), 1n, owner.address),
      "amount exceeds unallocated"
    );
  });

  it("rejects refund-window settings outside the safe bounds", async function () {
    const { owner, receiver } = await fixture();
    await expectRevert(receiver.connect(owner).setRefundWindow(59 * 60), "window too short");
    await expectRevert(receiver.connect(owner).setRefundWindow(31 * 24 * 60 * 60), "window too long");
    await receiver.connect(owner).setRefundWindow(2 * 60 * 60);
    assert.equal((await receiver.refundWindow()).toString(), String(2 * 60 * 60));
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
