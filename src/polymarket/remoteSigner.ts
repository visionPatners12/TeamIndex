import { createWalletClient, http, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { Env } from "../config/env";
import { CdpPolymarketSigner, type PoolSigningContext } from "./cdpSigner";

type TypedDataDomain = Record<string, unknown>;
type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>;
type TypedDataValue = Record<string, any>;

function jsonSafe(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

export class RemotePolymarketSigner {
  constructor(
    private readonly env: Env,
    private readonly poolId: string,
    private readonly context: PoolSigningContext,
  ) {
    if (!env.POLYMARKET_SIGNER_URL || !env.POLYMARKET_SIGNER_TOKEN) {
      throw new Error("POLYMARKET_SIGNER_URL and POLYMARKET_SIGNER_TOKEN are required");
    }
  }

  async getAddress() {
    return this.context.ownerAddress;
  }

  async _signTypedData(domain: TypedDataDomain, types: TypedDataTypes, value: TypedDataValue) {
    const primaryType = Object.keys(types).find((name) => name !== "EIP712Domain");
    if (!primaryType) throw new Error("Typed data primary type missing");
    return this.signTypedData(domain, types, value, primaryType);
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: TypedDataValue,
    primaryType: string,
  ) {
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
    const payload = (await response.json()) as { signature?: string; error?: string };
    if (!response.ok || !payload.signature) {
      throw new Error(payload.error ?? `Remote signer failed (${response.status})`);
    }
    return payload.signature;
  }

  createWalletClient() {
    const account = toAccount({
      address: this.context.ownerAddress as `0x${string}`,
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
}

export function createPolymarketSigner(
  env: Env,
  poolId: string,
  context: PoolSigningContext,
): CdpPolymarketSigner | RemotePolymarketSigner {
  if (env.POLYMARKET_SIGNER_URL && env.PROCESS_ROLE !== "signer") {
    return new RemotePolymarketSigner(env, poolId, context);
  }
  return new CdpPolymarketSigner(env, context);
}
