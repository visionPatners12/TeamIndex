import { expect } from "chai";
import {
  isFinancialSettlementEvent,
  isIgnoredProvisionalEvent,
  orderEventFinancialAction,
} from "../../src/workers/limitlessWebsocketTicker";

describe("Limitless websocket event classification", () => {
  it("ignores provisional MATCHED events for accounting", () => {
    const event = { source: "SETTLEMENT", type: "MATCHED", amountCollateral: "13.25" };
    expect(isIgnoredProvisionalEvent(event)).to.equal(true);
    expect(orderEventFinancialAction(event)).to.equal("ignore");
  });

  it("applies only MINED settlement events financially", () => {
    const event = { source: "SETTLEMENT", type: "MINED", amountCollateral: "13.25" };
    expect(isFinancialSettlementEvent(event)).to.equal(true);
    expect(orderEventFinancialAction(event)).to.equal("apply");
  });

  it("does not apply FAILED settlement events financially", () => {
    const event = { source: "SETTLEMENT", type: "FAILED", amountCollateral: "13.25" };
    expect(isFinancialSettlementEvent(event)).to.equal(false);
    expect(orderEventFinancialAction(event)).to.equal("failed");
  });
});
