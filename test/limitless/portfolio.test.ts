import { expect } from "chai";
import {
  extractRealizedPnl,
  humanOrBase6,
  normalizePortfolioPositions,
} from "../../src/limitless/limitlessPortfolio";

describe("Limitless portfolio normalization", () => {
  it("normalizes CLOB yes/no positions from /portfolio/positions", () => {
    const positions = normalizePortfolioPositions({
      clob: [
        {
          market: { slug: "psg-win" },
          positions: {
            yes: {
              cost: "75000000",
              fillPrice: "750000",
              realisedPnl: "0",
              unrealizedPnl: "25000000",
              marketValue: "100000000",
            },
            no: {
              cost: "25000000",
              fillPrice: "250000",
              realisedPnl: "0",
              unrealizedPnl: "-5000000",
              marketValue: "20000000",
            },
          },
        },
      ],
    });

    expect(positions).to.have.length(2);
    expect(positions[0]).to.include({
      marketSlug: "psg-win",
      outcome: "yes",
      outcomeIndex: 0,
      cost: 75,
      marketValue: 100,
      unrealizedPnl: 25,
    });
    expect(positions[0].quantity).to.equal(100);
    expect(positions[1]).to.include({
      outcome: "no",
      outcomeIndex: 1,
      cost: 25,
      marketValue: 20,
      unrealizedPnl: -5,
    });
  });

  it("normalizes AMM positions and empty responses", () => {
    expect(normalizePortfolioPositions({})).to.deep.equal([]);
    const positions = normalizePortfolioPositions({
      amm: [
        {
          market: { address: "0x123" },
          outcomeIndex: 0,
          collateralAmount: "100500000",
          outcomeTokenAmount: "50250000",
        },
      ],
    });
    expect(positions[0]).to.include({
      marketSlug: "0x123",
      outcome: "yes",
      cost: 100.5,
      marketValue: 100.5,
      quantity: 50.25,
    });
  });

  it("extracts realized pnl from pnl-chart current snapshot", () => {
    expect(extractRealizedPnl({ current: { realizedPnl: -7.04 } })).to.equal(-7.04);
    expect(humanOrBase6("123450000")).to.equal(123.45);
  });
});
