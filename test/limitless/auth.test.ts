import { expect } from "chai";
import { createHmac } from "crypto";
import { toUtf8String } from "ethers";
import { buildPathWithQuery, signLimitlessMessage } from "../../src/limitless/limitlessAuth";
import { encodeLimitlessSigningMessage } from "../../src/limitless/partnerAccounts";

describe("Limitless HMAC auth", () => {
  it("signs the websocket canonical message with base64 HMAC-SHA256", () => {
    const secretBytes = Buffer.from("teamindex-secret");
    const secret = secretBytes.toString("base64");
    const timestamp = "2026-06-25T12:00:00.000Z";
    const message = `${timestamp}\nGET\n/socket.io/?EIO=4&transport=websocket\n`;

    const expected = createHmac("sha256", secretBytes).update(message).digest("base64");
    expect(signLimitlessMessage(secret, message)).to.equal(expected);
  });

  it("keeps REST query params in the signed path", () => {
    expect(buildPathWithQuery("/portfolio/history", { limit: 100, cursor: "abc" }))
      .to.equal("/portfolio/history?limit=100&cursor=abc");
  });

  it("hex-encodes the Limitless signing message for x-signing-message", () => {
    const message = "Welcome to Limitless Exchange!\n\nNonce: 0xabc123";
    const encoded = encodeLimitlessSigningMessage(message);

    expect(encoded).to.match(/^0x[0-9a-f]+$/);
    expect(toUtf8String(encoded)).to.equal(message);
  });
});
