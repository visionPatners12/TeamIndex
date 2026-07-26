import assert from "node:assert/strict";
import { CdpPolymarketSigner } from "../../src/polymarket/cdpSigner";
import { decryptPoolCredential, encryptPoolCredential } from "../../src/polymarket/credentialCrypto";
import { baseUnitsToDecimal, decimalToBaseUnits } from "../../src/polymarket/money";
import { stableJson } from "../../src/polymarket/stableJson";
import {
  POLYMARKET_VAULT_DIRECT_CAPABILITY,
  PolymarketVaultDirectUnsupportedError,
  assertPolymarketVaultDirectSupported,
} from "../../src/polymarket/constants";

const owner = "0x1111111111111111111111111111111111111111";
const depositWallet = "0x2222222222222222222222222222222222222222";
const vault = "0x3333333333333333333333333333333333333333";

function env() {
  return {
    CDP_API_KEY_ID: "test-key",
    CDP_API_KEY_SECRET: "test-secret",
    CDP_WALLET_SECRET: "test-wallet-secret",
    POLYMARKET_CREDENTIALS_ENCRYPTION_KEY: "11".repeat(32),
    POLYGON_RPC_URL: "https://polygon.invalid",
    POLYMARKET_PUSD_ADDRESS: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    POLYMARKET_CTF_ADDRESS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    POLYMARKET_CTF_EXCHANGE_ADDRESS: "0xE111180000d2663C0091e4f400237545B87B996B",
    POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS: "0xe2222d279d744050d28e00520010520000310F59",
  } as any;
}

describe("Polymarket V2 backend architecture", function () {
  it("keeps vault-direct trading fail-closed without documented CLOB support", function () {
    assert.equal(POLYMARKET_VAULT_DIRECT_CAPABILITY.custody, "TEAMINDEX_VAULT");
    assert.equal(POLYMARKET_VAULT_DIRECT_CAPABILITY.canTrade, false);
    assert.throws(
      () => assertPolymarketVaultDirectSupported("test order"),
      (error: unknown) =>
        error instanceof PolymarketVaultDirectUnsupportedError
        && error.code === "POLYMARKET_CUSTOM_VAULT_UNSUPPORTED"
        && error.statusCode === 501,
    );
  });

  it("converts pUSD without floating-point loss", function () {
    assert.equal(decimalToBaseUnits("25.123456"), 25_123_456n);
    assert.equal(baseUnitsToDecimal(25_123_456n), "25.123456");
    assert.throws(() => decimalToBaseUnits("1.0000001"), /more than 6/);
  });

  it("canonicalizes proposal snapshots deterministically", function () {
    assert.equal(stableJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  });

  it("encrypts every pool credential with authenticated context", function () {
    const encrypted = encryptPoolCredential(env(), "pool-a", "secret", "clob-secret");
    assert.notEqual(encrypted, "clob-secret");
    assert.equal(decryptPoolCredential(env(), "pool-a", "secret", encrypted), "clob-secret");
    assert.throws(() => decryptPoolCredential(env(), "pool-b", "secret", encrypted));
  });

  it("rejects non-Polygon typed data before contacting CDP", async function () {
    const signer = new CdpPolymarketSigner(env(), {
      ownerAddress: owner,
      depositWalletAddress: depositWallet,
      vaultAddress: vault,
    });
    await assert.rejects(
      signer.signTypedData(
        { name: "ClobAuthDomain", version: "1", chainId: 8453 },
        { ClobAuth: [{ name: "address", type: "address" }] },
        { address: owner },
        "ClobAuth",
      ),
      /only Polygon 137/,
    );
  });

  it("rejects arbitrary Deposit Wallet batch calls", async function () {
    const signer = new CdpPolymarketSigner(env(), {
      ownerAddress: owner,
      depositWalletAddress: depositWallet,
      vaultAddress: vault,
    });
    await assert.rejects(
      signer.signTypedData(
        { name: "DepositWallet", version: "1", chainId: 137, verifyingContract: depositWallet },
        { Batch: [{ name: "wallet", type: "address" }] },
        {
          wallet: depositWallet,
          calls: [
            {
              target: "0x4444444444444444444444444444444444444444",
              value: "0",
              data: "0x12345678",
            },
          ],
        },
        "Batch",
      ),
      /rejected Deposit Wallet batch target/,
    );
  });

  it("rejects unsupported signing types", async function () {
    const signer = new CdpPolymarketSigner(env(), {
      ownerAddress: owner,
      depositWalletAddress: depositWallet,
      vaultAddress: vault,
    });
    await assert.rejects(
      signer.signTypedData({ chainId: 137 }, { Permit: [] }, {}, "Permit"),
      /unsupported EIP-712 primary type/,
    );
  });
});
