import { expect } from "chai";
import { extractExpectedExchangeAddress, postLimitlessOrder } from "../../src/limitless/limitlessOrderClient";

describe("Limitless order client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts the API-provided exchange address from invalid signature errors", () => {
    const message =
      'Limitless API 400 /orders: {"message":"Invalid signature. Exchange address for this market: 0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47","error":"Bad Request","statusCode":400}';

    expect(extractExpectedExchangeAddress(message)).to.equal("0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47");
    expect(extractExpectedExchangeAddress("Invalid signature")).to.equal(null);
  });

  it("posts delegated server-wallet orders with ownerId, onBehalfOf, and maker/signer addresses", async () => {
    const makerAddress = "0x4157A8f849199Dd076865E24C9d967f4244657b2";
    let postedBody: any = null;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/markets/test-market") {
        return new Response(JSON.stringify({
          slug: "test-market",
          venue: { exchange: "0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47" },
          tokens: { yes: "123", no: "456" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/orders") {
        postedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ orderId: "ord_1", status: "live" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await postLimitlessOrder(
      {
        LIMITLESS_BASE_URL: "https://limitless.test",
        LIMITLESS_API_KEY: "key",
        LIMITLESS_API_SECRET: Buffer.from("secret").toString("base64"),
        LIMITLESS_ORDER_SIGNER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945384c9e38a5fd8c33e6a4d7f3c7f7f2a7d8b",
      } as any,
      {
        marketSlug: "test-market",
        outcome: "yes",
        price: 0.56,
        size: 0.01,
        side: "BUY",
        orderType: "GTC",
        signingMode: "server-wallet",
        onBehalfOf: 1424206,
        makerAddress,
      }
    );

    expect(postedBody.ownerId).to.equal(1424206);
    expect(postedBody.onBehalfOf).to.equal(1424206);
    expect(postedBody.order.maker).to.equal(makerAddress);
    expect(postedBody.order.signer).to.equal(makerAddress);
  });
});
