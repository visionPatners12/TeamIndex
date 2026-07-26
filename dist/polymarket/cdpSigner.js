"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CdpPolymarketSigner = void 0;
const cdp_sdk_1 = require("@coinbase/cdp-sdk");
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const chains_1 = require("viem/chains");
const constants_1 = require("./constants");
const APPROVE_SELECTOR = (0, viem_1.toFunctionSelector)("approve(address,uint256)");
const TRANSFER_SELECTOR = (0, viem_1.toFunctionSelector)("transfer(address,uint256)");
const SET_APPROVAL_FOR_ALL_SELECTOR = (0, viem_1.toFunctionSelector)("setApprovalForAll(address,bool)");
const REDEEM_POSITIONS_SELECTOR = (0, viem_1.toFunctionSelector)("redeemPositions(address,bytes32,bytes32,uint256[])");
const MERGE_POSITIONS_SELECTOR = (0, viem_1.toFunctionSelector)("mergePositions(address,bytes32,bytes32,uint256[],uint256)");
const VAULT_DEPOSIT_SELECTOR = (0, viem_1.toFunctionSelector)("deposit(uint256,address)");
function asChainId(value) {
    if (typeof value === "number")
        return value;
    if (typeof value === "bigint")
        return Number(value);
    if (typeof value === "string" && value.trim())
        return Number(value);
    return undefined;
}
function sameAddress(a, b) {
    return typeof a === "string" && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}
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
function requireAddress(value, label) {
    if (!(0, viem_1.isAddress)(value))
        throw new Error(`${label} is not a valid EVM address`);
    return (0, viem_1.getAddress)(value);
}
/**
 * CDP-backed EIP-712 signer with a fail-closed Polymarket allowlist.
 * It deliberately rejects EIP-191 messages, raw hashes and transactions.
 */
class CdpPolymarketSigner {
    env;
    cdp;
    ownerAddress;
    depositWalletAddress;
    vaultAddress;
    allowedExchangeAddresses;
    allowedBatchTargets;
    constructor(env, context) {
        this.env = env;
        if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET || !env.CDP_WALLET_SECRET) {
            throw new Error("CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET are required");
        }
        this.ownerAddress = requireAddress(context.ownerAddress, "CDP owner address");
        this.depositWalletAddress = context.depositWalletAddress
            ? requireAddress(context.depositWalletAddress, "Deposit Wallet address")
            : undefined;
        this.vaultAddress = requireAddress(context.vaultAddress, "vault address");
        this.cdp = new cdp_sdk_1.CdpClient({
            apiKeyId: env.CDP_API_KEY_ID,
            apiKeySecret: env.CDP_API_KEY_SECRET,
            walletSecret: env.CDP_WALLET_SECRET,
        });
        this.allowedExchangeAddresses = new Set([env.POLYMARKET_CTF_EXCHANGE_ADDRESS, env.POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS].map((address) => address.toLowerCase()));
        this.allowedBatchTargets = new Map([
            [
                env.POLYMARKET_PUSD_ADDRESS.toLowerCase(),
                new Set([APPROVE_SELECTOR, TRANSFER_SELECTOR]),
            ],
            [
                env.POLYMARKET_CTF_ADDRESS.toLowerCase(),
                new Set([SET_APPROVAL_FOR_ALL_SELECTOR, REDEEM_POSITIONS_SELECTOR, MERGE_POSITIONS_SELECTOR]),
            ],
            [this.vaultAddress.toLowerCase(), new Set([VAULT_DEPOSIT_SELECTOR])],
        ]);
    }
    async getAddress() {
        return this.ownerAddress;
    }
    async _signTypedData(domain, types, value) {
        const primaryType = Object.keys(types).find((name) => name !== "EIP712Domain");
        if (!primaryType)
            throw new Error("Polymarket typed data has no primary type");
        return this.signTypedData(domain, types, value, primaryType);
    }
    async signTypedData(domain, types, value, primaryType) {
        this.validateTypedData(domain, value, primaryType);
        const result = await this.cdp.evm.signTypedData({
            address: this.ownerAddress,
            domain: jsonSafe(domain),
            types: jsonSafe(types),
            primaryType,
            message: jsonSafe(value),
        });
        return result.signature;
    }
    createWalletClient() {
        const account = (0, accounts_1.toAccount)({
            address: this.ownerAddress,
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
    validateTypedData(domain, value, primaryType) {
        const chainId = asChainId(domain.chainId);
        if (chainId !== undefined && chainId !== constants_1.POLYMARKET_CHAIN_ID) {
            throw new Error(`Signer rejected chainId ${chainId}; only Polygon 137 is allowed`);
        }
        if (primaryType === "ClobAuth") {
            if (!sameAddress(value.address, this.ownerAddress)) {
                throw new Error("Signer rejected ClobAuth for another address");
            }
            return;
        }
        if (primaryType === "TypedDataSign") {
            if (!this.depositWalletAddress)
                throw new Error("Deposit Wallet is not bound to this signer");
            if (!sameAddress(value.verifyingContract, this.depositWalletAddress)) {
                throw new Error("Signer rejected an order for another Deposit Wallet");
            }
            const verifyingContract = String(domain.verifyingContract ?? "").toLowerCase();
            if (!this.allowedExchangeAddresses.has(verifyingContract)) {
                throw new Error("Signer rejected an unknown CLOB exchange contract");
            }
            const order = value.contents ?? {};
            if (!sameAddress(order.maker, this.depositWalletAddress) || !sameAddress(order.signer, this.depositWalletAddress)) {
                throw new Error("Signer requires Deposit Wallet maker and signer fields");
            }
            if (Number(order.signatureType) !== 3)
                throw new Error("Signer requires Polymarket V2 signature type 3");
            return;
        }
        if (primaryType === "Batch") {
            if (!this.depositWalletAddress)
                throw new Error("Deposit Wallet is not bound to this signer");
            if (!sameAddress(domain.verifyingContract, this.depositWalletAddress)
                || !sameAddress(value.wallet, this.depositWalletAddress)) {
                throw new Error("Signer rejected a batch for another Deposit Wallet");
            }
            const calls = Array.isArray(value.calls) ? value.calls : [];
            if (calls.length === 0 || calls.length > 8)
                throw new Error("Signer rejected invalid batch size");
            for (const call of calls)
                this.validateBatchCall(call);
            return;
        }
        throw new Error(`Signer rejected unsupported EIP-712 primary type: ${primaryType}`);
    }
    validateBatchCall(call) {
        const target = String(call?.target ?? "").toLowerCase();
        const data = String(call?.data ?? "").toLowerCase();
        const value = BigInt(call?.value ?? 0);
        if (value !== 0n)
            throw new Error("Signer rejected native-token value in Deposit Wallet batch");
        const selectors = this.allowedBatchTargets.get(target);
        if (!selectors || !selectors.has(data.slice(0, 10))) {
            throw new Error(`Signer rejected Deposit Wallet batch target or selector: ${target}/${data.slice(0, 10)}`);
        }
    }
}
exports.CdpPolymarketSigner = CdpPolymarketSigner;
