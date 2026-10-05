import assert from "node:assert/strict";
import { fetchDataApiPositions } from "../../src/polymarket/accountingService";
import { parseMarketQuotes } from "../../src/workers/polymarketMarketWs";

describe("Polymarket market data pipeline", () => {
  it("reads both raw book and incremental top-of-book messages", () => {
    const quotes = parseMarketQuotes([
      {
        event_type: "book",
        asset_id: "token-a",
        bids: [{ price: "0.42", size: "10" }, { price: "0.43", size: "5" }],
        asks: [{ price: "0.46", size: "5" }, { price: "0.45", size: "10" }],
      },
      {
        event_type: "price_change",
        price_changes: [{ asset_id: "token-a", best_bid: "0.44", best_ask: "0.45" }],
      },
    ]);
    assert.deepEqual(quotes.map((q) => [q.tokenId, q.bestBid, q.bestAsk]), [
      ["token-a", 0.43, 0.45],
      ["token-a", 0.44, 0.45],
    ]);
    assert.equal(parseMarketQuotes({ event_type: "book", asset_id: "x", bids: [{ price: "2" }] }).length, 0);
  });

  it("fetches all position pages including archived active markets", async () => {
    const originalFetch = global.fetch;
    const offsets: number[] = [];
    try {
      global.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        offsets.push(Number(url.searchParams.get("offset")));
        assert.equal(url.searchParams.get("includeArchived"), "true");
        const count = offsets.length === 1 ? 500 : 1;
        return { ok: true, json: async () => Array.from({ length: count }, (_, n) => ({ asset: `${offsets.length}-${n}` })) } as Response;
      }) as typeof fetch;
      const positions = await fetchDataApiPositions({ POLYMARKET_DATA_API_URL: "https://data-api.polymarket.com" } as any, "0x123");
      assert.equal(positions.length, 501);
      assert.deepEqual(offsets, [0, 500]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("rejects malformed pages before closing any stored position", async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = (async () => ({ ok: true, json: async () => ({ data: [] }) } as Response)) as typeof fetch;
      await assert.rejects(
        fetchDataApiPositions({ POLYMARKET_DATA_API_URL: "https://data-api.polymarket.com" } as any, "0x123"),
        /invalid page/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
