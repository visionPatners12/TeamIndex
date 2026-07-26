import { CdpClient } from "@coinbase/cdp-sdk";
import { createWalletClient, getAddress, http, isAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { Env } from "../config/env";
import { POLYMARKET_CHAIN_ID } from "./constants";

type TypedDataDomain = Record<string, unknown>;
type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>;
type TypedDataValue = Record<string, any>;

export type PoolSigningContext = {
  ownerAddress: string;
  depositWalletAddress?: string;
  vaultAddress: string;
};

const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");
const TRANSFER_SELECTOR = toFunctionSelector("transfer(address,uint256)");
const SET_APPROVAL_FOR_ALL_SELECTOR = toFunctionSelector("setApprovalForAll(address,bool)");
const REDEEM_POSITIONS_SELECTOR = toFunctionSelector(
  "redeemPositions(address,bytes32,bytes32,uint256[])",
);
const MERGE_POSITIONS_SELECTOR = toFunctionSelector(
  "mergePositions(address,bytes32,bytes32,uint256[],uint256)",
);
const VAULT_DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");

function asChainId(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) return Number(value);
  return undefined;
}

function sameAddress(a: unknown, b: string | undefined): boolean {
  return typeof a === "string" && Boolean(b) && a.toLowerCase() === b!.toLowerCase();
}

function jsonSafe(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

function requireAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
  return getAddress(value);
}

/**
 * CDP-backed EIP-712 signer with a fail-closed Polymarket allowlist.
 * It deliberately rejects EIP-191 messages, raw hashes and transactions.
 */
export class CdpPolymarketSigner {
  private readonly cdp: CdpClient;
  private readonly ownerAddress: Address;
  private readonly depositWalletAddress?: Address;
  private readonly vaultAddress: Address;
  private readonly allowedExchangeAddresses: Set<string>;
  private readonly allowedBatchTargets: Map<string, Set<string>>;

  constructor(private readonly env: Env, context: PoolSigningContext) {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET || !env.CDP_WALLET_SECRET) {
      throw new Error("CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET are required");
    }
    this.ownerAddress = requireAddress(context.ownerAddress, "CDP owner address");
    this.depositWalletAddress = context.depositWalletAddress
      ? requireAddress(context.depositWalletAddress, "Deposit Wallet address")
      : undefined;
    this.vaultAddress = requireAddress(context.vaultAddress, "vault address");
    this.cdp = new CdpClient({
      apiKeyId: env.CDP_API_KEY_ID,
      apiKeySecret: env.CDP_API_KEY_SECRET,
      walletSecret: env.CDP_WALLET_SECRET,
    });

    this.allowedExchangeAddresses = new Set(
      [env.POLYMARKET_CTF_EXCHANGE_ADDRESS, env.POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS].map((address) =>
        address.toLowerCase(),
      ),
    );
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

  async getAddress(): Promise<string> {
    return this.ownerAddress;
  }

  async _signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: TypedDataValue,
  ): Promise<string> {
    const primaryType = Object.keys(types).find((name) => name !== "EIP712Domain");
    if (!primaryType) throw new Error("Polymarket typed data has no primary type");
    return this.signTypedData(domain, types, value, primaryType);
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: TypedDataValue,
    primaryType: string,
  ): Promise<string> {
    this.validateTypedData(domain, value, primaryType);
    const result = await this.cdp.evm.signTypedData({
      address: this.ownerAddress,
      domain: jsonSafe(domain) as any,
      types: jsonSafe(types) as any,
      primaryType,
      message: jsonSafe(value) as any,
    });
    return result.signature;
  }

  createWalletClient() {
    const account = toAccount({
      address: this.ownerAddress,
      signMessage: async () => {
        throw new Error("EIP-191 signing is disabled for the Polymarket pool signer");
      },
      signTransaction: async () => {
        throw new Error("Direct transaction signing is disabled for the Polymarket pool signer");
      },
      signTypedData: async ({ domain, types, message, primaryType }) =>
        (await this.signTypedData(domain as any, types as any, message as any, String(primaryType))) as Hex,
    });
    return createWalletClient({
      account,
      chain: polygon,
      transport: http(this.env.POLYGON_RPC_URL),
    });
  }

  private validateTypedData(domain: TypedDataDomain, value: TypedDataValue, primaryType: string) {
    const chainId = asChainId(domain.chainId);
    if (chainId !== undefined && chainId !== POLYMARKET_CHAIN_ID) {
      throw new Error(`Signer rejected chainId ${chainId}; only Polygon 137 is allowed`);
    }

    if (primaryType === "ClobAuth") {
      if (!sameAddress(value.address, this.ownerAddress)) {
        throw new Error("Signer rejected ClobAuth for another address");
      }
      return;
    }

    if (primaryType === "TypedDataSign") {
      if (!this.depositWalletAddress) throw new Error("Deposit Wallet is not bound to this signer");
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
      if (Number(order.signatureType) !== 3) throw new Error("Signer requires Polymarket V2 signature type 3");
      return;
    }

    if (primaryType === "Batch") {
      if (!this.depositWalletAddress) throw new Error("Deposit Wallet is not bound to this signer");
      if (
        !sameAddress(domain.verifyingContract, this.depositWalletAddress)
        || !sameAddress(value.wallet, this.depositWalletAddress)
      ) {
        throw new Error("Signer rejected a batch for another Deposit Wallet");
      }
      const calls = Array.isArray(value.calls) ? value.calls : [];
      if (calls.length === 0 || calls.length > 8) throw new Error("Signer rejected invalid batch size");
      for (const call of calls) this.validateBatchCall(call);
      return;
    }

    throw new Error(`Signer rejected unsupported EIP-712 primary type: ${primaryType}`);
  }

  private validateBatchCall(call: any) {
    const target = String(call?.target ?? "").toLowerCase();
    const data = String(call?.data ?? "").toLowerCase();
    const value = BigInt(call?.value ?? 0);
    if (value !== 0n) throw new Error("Signer rejected native-token value in Deposit Wallet batch");
    const selectors = this.allowedBatchTargets.get(target);
    if (!selectors || !selectors.has(data.slice(0, 10))) {
      throw new Error(`Signer rejected Deposit Wallet batch target or selector: ${target}/${data.slice(0, 10)}`);
    }
  }
}
