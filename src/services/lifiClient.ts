import { ethers } from "ethers";
import type { Env } from "../config/env";

export type LifiQuote = {
  transactionRequest: {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  estimate?: {
    approvalAddress?: string;
    toAmount?: string;
    toAmountMin?: string;
  };
};

export async function getLifiQuote(
  env: Env,
  params: {
    fromChain: number;
    toChain: number;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    fromAddress: string;
    toAddress: string;
    slippage?: string;
  }
): Promise<LifiQuote> {
  const baseUrl = (env.LIFI_BASE_URL || "https://li.quest/v1").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/quote`);
  url.searchParams.set("fromChain", String(params.fromChain));
  url.searchParams.set("toChain", String(params.toChain));
  url.searchParams.set("fromToken", params.fromToken);
  url.searchParams.set("toToken", params.toToken);
  url.searchParams.set("fromAmount", params.fromAmount);
  url.searchParams.set("fromAddress", params.fromAddress);
  url.searchParams.set("toAddress", params.toAddress);
  url.searchParams.set("slippage", params.slippage ?? env.LIFI_SLIPPAGE ?? "0.005");
  if (env.LIFI_INTEGRATOR) url.searchParams.set("integrator", env.LIFI_INTEGRATOR);

  const headers: Record<string, string> = {};
  if (env.LIFI_API_KEY) headers["x-lifi-api-key"] = env.LIFI_API_KEY;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LI.FI quote failed ${response.status}: ${body.slice(0, 500)}`);
  }

  const quote = (await response.json()) as LifiQuote;
  if (!quote.transactionRequest?.to || !quote.transactionRequest?.data) {
    throw new Error("LI.FI quote missing transactionRequest");
  }
  if (!quote.estimate?.approvalAddress) {
    throw new Error("LI.FI quote missing approvalAddress");
  }

  return quote;
}

export function lifiQuoteToTransactionRequest(quote: LifiQuote): ethers.TransactionRequest {
  const tx = quote.transactionRequest;
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined
  };
}
