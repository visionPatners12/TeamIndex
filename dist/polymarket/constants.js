"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolymarketVaultDirectUnsupportedError = exports.POLYMARKET_VAULT_DIRECT_CAPABILITY = exports.LEGACY_DISABLED_RESPONSE = exports.POLYMARKET_DEFAULTS = exports.PUSD_DECIMALS = exports.POLYMARKET_CHAIN_ID = void 0;
exports.assertPolymarketVaultDirectSupported = assertPolymarketVaultDirectSupported;
exports.POLYMARKET_CHAIN_ID = 137;
exports.PUSD_DECIMALS = 6;
exports.POLYMARKET_DEFAULTS = {
    pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B",
    negRiskExchange: "0xe2222d279d744050d28e00520010520000310F59",
    depositWalletFactory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
};
exports.LEGACY_DISABLED_RESPONSE = {
    error: "Limitless is legacy and disabled. Polymarket V2 on Polygon is the only active trading provider.",
    code: "LIMITLESS_LEGACY_DISABLED",
};
/**
 * The target custody model keeps pUSD and conditional tokens in the TeamIndex
 * vault. Polymarket's public CLOB documentation does not currently support a
 * generic custom ERC-1271 vault as maker/funder, so this path stays fail-closed.
 */
exports.POLYMARKET_VAULT_DIRECT_CAPABILITY = {
    mode: "VAULT_DIRECT",
    status: "BLOCKED",
    canTrade: false,
    canBootstrap: false,
    custody: "TEAMINDEX_VAULT",
    code: "POLYMARKET_CUSTOM_VAULT_UNSUPPORTED",
    reason: "Polymarket's public CLOB API does not document support for a custom TeamIndex ERC-1271 vault as maker/funder. Deposit Wallet funding is disabled so pool assets remain in the vault.",
    documentationUrl: "https://docs.polymarket.com/api-reference/authentication",
};
class PolymarketVaultDirectUnsupportedError extends Error {
    code = exports.POLYMARKET_VAULT_DIRECT_CAPABILITY.code;
    statusCode = 501;
    constructor(operation) {
        super(`${operation} is disabled: ${exports.POLYMARKET_VAULT_DIRECT_CAPABILITY.reason}`);
        this.name = "PolymarketVaultDirectUnsupportedError";
    }
}
exports.PolymarketVaultDirectUnsupportedError = PolymarketVaultDirectUnsupportedError;
function assertPolymarketVaultDirectSupported(operation) {
    throw new PolymarketVaultDirectUnsupportedError(operation);
}
