"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.returnIdlePusdToVault = returnIdlePusdToVault;
exports.executeNextTradeIntent = executeNextTradeIntent;
exports.executeClaimedTradeIntent = executeClaimedTradeIntent;
const ethers_1 = require("ethers");
const clob_client_v2_1 = require("@polymarket/clob-client-v2");
const prisma_1 = require("../db/prisma");
const polygonV2_1 = require("../onchain/polygonV2");
const poolClobClient_1 = require("./poolClobClient");
const poolAccountService_1 = require("./poolAccountService");
const money_1 = require("./money");
const remoteSigner_1 = require("./remoteSigner");
const constants_1 = require("./constants");
const erc20Abi = [
    "function balanceOf(address account) view returns (uint256)",
    "function transfer(address to,uint256 amount) returns (bool)",
];
function tickAlignedCeiling(value, tick) {
    const tickNumber = Number(tick);
    const places = (tick.split(".")[1] ?? "").length;
    return Number((Math.ceil((value - Number.EPSILON) / tickNumber) * tickNumber).toFixed(places));
}
function responseOrderId(response) {
    return response?.orderID ?? response?.orderId ?? response?.id ?? null;
}
async function returnIdlePusdToVault(env, poolId) {
    const account = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
    if (!account)
        throw new Error("Pool Polymarket account not found");
    const pUSD = new ethers_1.Contract(env.POLYMARKET_PUSD_ADDRESS, erc20Abi, (0, polygonV2_1.getPolygonProvider)(env));
    const balance = (await pUSD.balanceOf(account.depositWalletAddress));
    if (balance === 0n)
        return { amountBaseUnits: "0", relayerTransactionHash: null, syncTxHash: null };
    const signer = (0, remoteSigner_1.createPolymarketSigner)(env, poolId, {
        ownerAddress: account.cdpOwnerAddress,
        depositWalletAddress: account.depositWalletAddress,
        vaultAddress: account.vaultAddress,
    });
    const relay = (0, poolAccountService_1.createPoolRelayClient)(env, signer);
    const data = pUSD.interface.encodeFunctionData("transfer", [account.vaultAddress, balance]);
    const transaction = await relay.executeDepositWalletBatch([{ target: env.POLYMARKET_PUSD_ADDRESS, value: "0", data }], account.depositWalletAddress, String(Math.floor(Date.now() / 1000) + 10 * 60));
    const mined = await transaction.wait();
    if (!mined || ["STATE_FAILED", "STATE_INVALID"].includes(mined.state)) {
        throw new Error("Returning idle pUSD from Deposit Wallet failed");
    }
    const syncTxHash = await (0, polygonV2_1.syncPoolReturnedCapital)(env, account.vaultAddress);
    await prisma_1.prisma.pool_capital_movements.upsert({
        where: { idempotencyKey: `return:${transaction.transactionID}` },
        create: {
            poolId,
            idempotencyKey: `return:${transaction.transactionID}`,
            type: "RETURN",
            amount: (0, money_1.baseUnitsToDecimal)(balance),
            txHash: mined.transactionHash,
            status: "CONFIRMED",
            rawJson: { relayerTransactionId: transaction.transactionID, syncTxHash },
        },
        update: {},
    });
    return { amountBaseUnits: balance.toString(), relayerTransactionHash: mined.transactionHash, syncTxHash };
}
async function executeNextTradeIntent(env, workerId) {
    (0, constants_1.assertPolymarketVaultDirectSupported)("Polymarket trade execution");
    const next = await prisma_1.prisma.pool_trade_intents.findFirst({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
    });
    if (!next)
        return null;
    const claimed = await prisma_1.prisma.pool_trade_intents.updateMany({
        where: { id: next.id, status: "PENDING" },
        data: { status: "FUNDING", lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1)
        return null;
    return executeClaimedTradeIntent(env, next.id);
}
async function executeClaimedTradeIntent(env, intentId) {
    const intent = await prisma_1.prisma.pool_trade_intents.findUnique({ where: { id: intentId } });
    if (!intent || intent.status !== "FUNDING")
        throw new Error("Trade intent is not claimed for funding");
    const account = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId: intent.poolId } });
    if (!account || account.status !== "READY" || !account.approvalsReady) {
        throw new Error("Pool Deposit Wallet is not ready for trading");
    }
    const fundingKey = `fund:${intent.id}`;
    const fundingAmount = (0, money_1.decimalToBaseUnits)(intent.reservedPusd.toString());
    await prisma_1.prisma.pool_capital_movements.upsert({
        where: { idempotencyKey: fundingKey },
        create: {
            poolId: intent.poolId,
            idempotencyKey: fundingKey,
            type: "ALLOCATE",
            amount: intent.reservedPusd,
            proposalHash: intent.proposalHash,
            status: "SUBMITTING",
        },
        update: {},
    });
    try {
        const fundingTxHash = await (0, polygonV2_1.allocatePoolCapital)(env, account.vaultAddress, intent.proposalHash, fundingAmount);
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.pool_capital_movements.update({
                where: { idempotencyKey: fundingKey },
                data: { txHash: fundingTxHash, status: "CONFIRMED" },
            }),
            prisma_1.prisma.pool_trade_intents.update({
                where: { id: intent.id },
                data: { status: "FUNDED", metadataJson: { fundingTxHash } },
            }),
        ]);
        const clob = (0, poolClobClient_1.createPoolClobClient)(env, account);
        const [tickSize, negRisk, feeRateBps, marketPrice] = await Promise.all([
            clob.getTickSize(intent.tokenId),
            clob.getNegRisk(intent.tokenId),
            clob.getFeeRateBps(intent.tokenId),
            clob.calculateMarketPrice(intent.tokenId, clob_client_v2_1.Side.BUY, (0, money_1.decimalToSdkNumber)(intent.amount.toString(), "order amount"), clob_client_v2_1.OrderType.FAK),
        ]);
        const referencePrice = (0, money_1.decimalToSdkNumber)(intent.limitPrice.toString(), "limit price");
        const cap = Math.min(0.9999, referencePrice * (1 + intent.maxSlippageBps / 10_000));
        if (marketPrice > cap)
            throw new Error(`Market price ${marketPrice} exceeds slippage cap ${cap}`);
        const orderPrice = tickAlignedCeiling(cap, tickSize);
        await prisma_1.prisma.pool_trade_intents.update({
            where: { id: intent.id },
            data: { status: "SUBMITTING" },
        });
        const response = await clob.createAndPostMarketOrder({
            tokenID: intent.tokenId,
            amount: (0, money_1.decimalToSdkNumber)(intent.amount.toString(), "order amount"),
            side: clob_client_v2_1.Side.BUY,
            price: orderPrice,
            orderType: clob_client_v2_1.OrderType.FAK,
            builderCode: env.POLYMARKET_BUILDER_CODE,
        }, { tickSize, negRisk }, clob_client_v2_1.OrderType.FAK);
        const externalOrderId = responseOrderId(response);
        const status = String(response?.status ?? (response?.success ? "MATCHED" : "SUBMITTED")).toUpperCase();
        const order = await prisma_1.prisma.pool_polymarket_orders.create({
            data: {
                poolId: intent.poolId,
                accountId: account.id,
                intentId: intent.id,
                externalOrderId,
                conditionId: intent.conditionId,
                tokenId: intent.tokenId,
                side: intent.side,
                orderType: "FAK",
                price: orderPrice.toFixed(6),
                originalSize: intent.amount,
                matchedSize: response?.takingAmount ?? 0,
                feeRateBps,
                status,
                submittedAt: new Date(),
                closedAt: ["MATCHED", "CANCELLED", "FAILED"].includes(status) ? new Date() : null,
                rawJson: response,
            },
        });
        await prisma_1.prisma.pool_trade_intents.update({
            where: { id: intent.id },
            data: { status: "SUBMITTED", lockedAt: null, lockedBy: null },
        });
        const returned = await returnIdlePusdToVault(env, intent.poolId);
        return { intentId: intent.id, orderId: order.id, externalOrderId, status, returned };
    }
    catch (error) {
        const current = await prisma_1.prisma.pool_trade_intents.findUnique({ where: { id: intent.id } });
        const uncertain = current?.status === "SUBMITTING";
        await prisma_1.prisma.pool_trade_intents.update({
            where: { id: intent.id },
            data: {
                status: uncertain ? "NEEDS_RECONCILIATION" : "FAILED",
                lastError: String(error?.message ?? error).slice(0, 2_000),
                lockedAt: null,
                lockedBy: null,
            },
        });
        throw error;
    }
}
