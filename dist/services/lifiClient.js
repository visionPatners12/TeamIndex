"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLifiQuote = getLifiQuote;
exports.lifiQuoteToTransactionRequest = lifiQuoteToTransactionRequest;
async function getLifiQuote(env, params) {
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
    if (env.LIFI_INTEGRATOR)
        url.searchParams.set("integrator", env.LIFI_INTEGRATOR);
    const headers = {};
    if (env.LIFI_API_KEY)
        headers["x-lifi-api-key"] = env.LIFI_API_KEY;
    const response = await fetch(url, { headers });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`LI.FI quote failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const quote = (await response.json());
    if (!quote.transactionRequest?.to || !quote.transactionRequest?.data) {
        throw new Error("LI.FI quote missing transactionRequest");
    }
    if (!quote.estimate?.approvalAddress) {
        throw new Error("LI.FI quote missing approvalAddress");
    }
    return quote;
}
function lifiQuoteToTransactionRequest(quote) {
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
