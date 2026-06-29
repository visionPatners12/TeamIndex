import { expect } from "chai";
import { extractExpectedExchangeAddress } from "../../src/limitless/limitlessOrderClient";

describe("Limitless order client", () => {
  it("extracts the API-provided exchange address from invalid signature errors", () => {
    const message =
      'Limitless API 400 /orders: {"message":"Invalid signature. Exchange address for this market: 0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47","error":"Bad Request","statusCode":400}';

    expect(extractExpectedExchangeAddress(message)).to.equal("0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47");
    expect(extractExpectedExchangeAddress("Invalid signature")).to.equal(null);
  });
});
