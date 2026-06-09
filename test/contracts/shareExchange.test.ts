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

describe("ShareExchange", function () {
  async function fixture() {
    const [owner, seller, buyer, treasury, stranger] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Share = await ethers.getContractFactory("WrappedVaultShare");
    const share = await Share.deploy("Club Share", "CLUB", owner.address);
    await share.waitForDeployment();

    const Exchange = await ethers.getContractFactory("ShareExchange");
    const exchange = await Exchange.deploy(await usdc.getAddress(), owner.address, treasury.address);
    await exchange.waitForDeployment();

    await exchange.connect(owner).setShareTokenEnabled(await share.getAddress(), true);
    await share.connect(owner).mint(seller.address, ethers.parseUnits("10", 18), ethers.ZeroHash);
    await usdc.mint(buyer.address, 10_000_000n);

    await share.connect(seller).approve(await exchange.getAddress(), ethers.MaxUint256);
    await usdc.connect(buyer).approve(await exchange.getAddress(), ethers.MaxUint256);

    return { owner, seller, buyer, treasury, stranger, usdc, share, exchange };
  }

  it("creates a fixed-price sell order and fills it partially", async function () {
    const { seller, buyer, usdc, share, exchange } = await fixture();

    const shareAmount = ethers.parseUnits("10", 18);
    const partial = ethers.parseUnits("4", 18);
    await exchange.connect(seller).createSellOrder(await share.getAddress(), shareAmount, 2_500_000n);

    assert.equal((await share.balanceOf(await exchange.getAddress())).toString(), shareAmount.toString());
    assert.equal((await exchange.quoteOrder(1, partial)).toString(), "10000000");

    await exchange.connect(buyer).buy(1, partial);

    const order = await exchange.sellOrders(1);
    assert.equal(order.remainingShares.toString(), ethers.parseUnits("6", 18).toString());
    assert.equal(order.active, true);
    assert.equal((await share.balanceOf(buyer.address)).toString(), partial.toString());
    assert.equal((await usdc.balanceOf(seller.address)).toString(), "10000000");
  });

  it("charges seller-side exchange fees", async function () {
    const { owner, seller, buyer, treasury, usdc, share, exchange } = await fixture();

    await exchange.connect(owner).setFeeConfig(100n, treasury.address);
    await exchange.connect(seller).createSellOrder(
      await share.getAddress(),
      ethers.parseUnits("1", 18),
      1_000_000n
    );

    await exchange.connect(buyer).buy(1, ethers.parseUnits("1", 18));

    assert.equal((await usdc.balanceOf(treasury.address)).toString(), "10000");
    assert.equal((await usdc.balanceOf(seller.address)).toString(), "990000");
  });

  it("lets the seller cancel remaining escrowed shares", async function () {
    const { seller, buyer, share, exchange } = await fixture();

    await exchange.connect(seller).createSellOrder(
      await share.getAddress(),
      ethers.parseUnits("10", 18),
      1_000_000n
    );
    await exchange.connect(buyer).buy(1, ethers.parseUnits("3", 18));
    await exchange.connect(seller).cancelSellOrder(1);

    const order = await exchange.sellOrders(1);
    assert.equal(order.remainingShares.toString(), "0");
    assert.equal(order.active, false);
    assert.equal((await share.balanceOf(seller.address)).toString(), ethers.parseUnits("7", 18).toString());
  });

  it("enforces share whitelist, pause, and order permissions", async function () {
    const { owner, seller, stranger, share, exchange } = await fixture();
    const amount = ethers.parseUnits("1", 18);

    await exchange.connect(owner).setShareTokenEnabled(await share.getAddress(), false);
    await expectRevert(
      exchange.connect(seller).createSellOrder(await share.getAddress(), amount, 1_000_000n),
      "share token disabled"
    );

    await exchange.connect(owner).setShareTokenEnabled(await share.getAddress(), true);
    await exchange.connect(seller).createSellOrder(await share.getAddress(), amount, 1_000_000n);
    await expectRevert(exchange.connect(stranger).cancelSellOrder(1), "not authorized");

    await exchange.connect(owner).pause();
    await expectRevert(
      exchange.connect(seller).createSellOrder(await share.getAddress(), amount, 1_000_000n),
      "EnforcedPause"
    );
  });

  it("supports USDC-decimal ERC4626 vault shares", async function () {
    const { owner, seller, buyer, usdc, exchange } = await fixture();

    const Vault = await ethers.getContractFactory("USDC4626Vault");
    const implementation = await Vault.deploy();
    await implementation.waitForDeployment();

    const Factory = await ethers.getContractFactory("ClubVaultFactory");
    const factory = await Factory.deploy(
      await usdc.getAddress(),
      await implementation.getAddress(),
      owner.address,
      owner.address
    );
    await factory.waitForDeployment();

    const clubId = ethers.solidityPackedKeccak256(["string"], ["Exchange Test Club"]);
    await factory.createClubVault(clubId, "Club Vault", "cvUSDC", 0);
    const vault = Vault.attach(await factory.getVaultByClub(clubId));
    await exchange.connect(owner).setShareTokenEnabled(await vault.getAddress(), true);

    await usdc.mint(seller.address, 1_000_000n);
    await usdc.connect(seller).approve(await vault.getAddress(), 1_000_000n);
    await vault.connect(seller).deposit(1_000_000n, seller.address);
    await vault.connect(seller).approve(await exchange.getAddress(), 1_000_000n);

    await exchange.connect(seller).createSellOrder(await vault.getAddress(), 1_000_000n, 1_200_000n);
    await exchange.connect(buyer).buy(1, 500_000n);

    assert.equal((await exchange.quoteOrder(1, 500_000n)).toString(), "600000");
    assert.equal((await vault.balanceOf(buyer.address)).toString(), "500000");
  });
});
