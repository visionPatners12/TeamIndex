import { expect } from "chai";
import { calculatePoolValuation } from "../../src/services/priceEngine";

describe("priceEngine valuation", () => {
  it("prices shares from vault cash, server-wallet cash, positions, and realized PnL", () => {
    const valuation = calculatePoolValuation({
      vaultCash: 100,
      serverWalletCash: 25,
      openPositionsValue: 50,
      realizedPnl: -10,
      totalTokenSupplyRaw: 165_000_000,
    });

    expect(valuation.cash).to.equal(125);
    expect(valuation.totalPoolValue).to.equal(165);
    expect(valuation.totalSupplyHuman).to.equal(165);
    expect(valuation.officialTokenPrice).to.equal(1);
  });

  it("treats a missing server wallet as zero cash", () => {
    const valuation = calculatePoolValuation({
      vaultCash: 100,
      serverWalletCash: 0,
      openPositionsValue: 50,
      realizedPnl: 0,
      totalTokenSupplyRaw: 150_000_000,
    });

    expect(valuation.cash).to.equal(100);
    expect(valuation.totalPoolValue).to.equal(150);
    expect(valuation.officialTokenPrice).to.equal(1);
  });

  it("returns a zero price when supply is zero", () => {
    const valuation = calculatePoolValuation({
      vaultCash: 100,
      serverWalletCash: 25,
      openPositionsValue: 50,
      realizedPnl: -10,
      totalTokenSupplyRaw: 0,
    });

    expect(valuation.totalPoolValue).to.equal(165);
    expect(valuation.officialTokenPrice).to.equal(0);
  });

  it("pushes only server cash plus open positions as synthetic onchain valuation", () => {
    const valuation = calculatePoolValuation({
      vaultCash: 100,
      serverWalletCash: 25,
      openPositionsValue: 50,
      realizedPnl: -10,
      totalTokenSupplyRaw: 165_000_000,
    });

    expect(valuation.syntheticOnchainPositionsValue).to.equal(75);
  });
});
