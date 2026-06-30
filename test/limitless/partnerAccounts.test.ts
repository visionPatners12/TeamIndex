import { expect } from "chai";
import { createPartnerServerAccount, partnerAccountAllowanceReady } from "../../src/limitless/partnerAccounts";

describe("Limitless partner accounts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts account as the server-wallet address in partner account responses", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          profileId: 1424201,
          account: "0x4157A8f849199Dd076865E24C9d967f4244657b2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const created = await createPartnerServerAccount(
      {
        LIMITLESS_BASE_URL: "https://limitless.test",
        LIMITLESS_API_KEY: "key",
        LIMITLESS_API_SECRET: Buffer.from("secret").toString("base64"),
      } as any,
      "pool-test"
    );

    expect(created.limitlessProfileId).to.equal("1424201");
    expect(created.accountAddress).to.equal("0x4157A8f849199Dd076865E24C9d967f4244657b2");
    expect(requests[0].url).to.equal("https://limitless.test/profiles/partner-accounts");
  });

  it("keeps allowance pending while Limitless reports pending/missing statuses", () => {
    expect(partnerAccountAllowanceReady({ allowances: [{ status: "PENDING" }] })).to.equal(false);
    expect(partnerAccountAllowanceReady({ allowances: [{ status: "missing", retryable: true }] })).to.equal(false);
  });

  it("marks allowance ready only for ready statuses", () => {
    expect(partnerAccountAllowanceReady({ allowances: [{ status: "approved" }, { allowanceStatus: "ACTIVE" }] }))
      .to.equal(true);
  });
});
