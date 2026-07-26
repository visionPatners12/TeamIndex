"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemotePolymarketSigner = void 0;
exports.createPolymarketSigner = createPolymarketSigner;
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const chains_1 = require("viem/chains");
const cdpSigner_1 = require("./cdpSigner");
function jsonSafe(value) {
    if (typeof value === "bigint")
        return value.toString();
    if (Array.isArray(value))
        return value.map(jsonSafe);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
    }
    return value;
}
class RemotePolymarketSigner {
    env;
    poolId;
    context;
    constructor(env, poolId, context) {
        this.env = env;
        this.poolId = poolId;
        this.context = context;
        if (!env.POLYMARKET_SIGNER_URL || !env.POLYMARKET_SIGNER_TOKEN) {
            throw new Error("POLYMARKET_SIGNER_URL and POLYMARKET_SIGNER_TOKEN are required");
        }
    }
    async getAddress() {
        return this.context.ownerAddress;
    }
    async _signTypedData(domain, types, value) {
        const primaryType = Object.keys(types).find((name) => name !== "EIP712Domain");
        if (!primaryType)
            throw new Error("Typed data primary type missing");
        return this.signTypedData(domain, types, value, primaryType);
    }
    async signTypedData(domain, types, value, primaryType) {
        const response = await fetch(new URL("/internal/polymarket/sign", this.env.POLYMARKET_SIGNER_URL), {
            method: "POST",
            headers: {
                authorization: `Bearer ${this.env.POLYMARKET_SIGNER_TOKEN}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                poolId: this.poolId,
                domain: jsonSafe(domain),
                types: jsonSafe(types),
                value: jsonSafe(value),
                primaryType,
            }),
            signal: AbortSignal.timeout(20_000),
        });
        const payload = (await response.json());
        if (!response.ok || !payload.signature) {
            throw new Error(payload.error ?? `Remote signer failed (${response.status})`);
        }
        return payload.signature;
    }
    createWalletClient() {
        const account = (0, accounts_1.toAccount)({
            address: this.context.ownerAddress,
            signMessage: async () => {
                throw new Error("EIP-191 signing is disabled for the Polymarket pool signer");
            },
            signTransaction: async () => {
                throw new Error("Direct transaction signing is disabled for the Polymarket pool signer");
            },
            signTypedData: async ({ domain, types, message, primaryType }) => (await this.signTypedData(domain, types, message, String(primaryType))),
        });
        return (0, viem_1.createWalletClient)({
            account,
            chain: chains_1.polygon,
            transport: (0, viem_1.http)(this.env.POLYGON_RPC_URL),
        });
    }
}
exports.RemotePolymarketSigner = RemotePolymarketSigner;
function createPolymarketSigner(env, poolId, context) {
    if (env.POLYMARKET_SIGNER_URL && env.PROCESS_ROLE !== "signer") {
        return new RemotePolymarketSigner(env, poolId, context);
    }
    return new cdpSigner_1.CdpPolymarketSigner(env, context);
}
