import { Contract } from "ethers";
import { OrderType, Side as ClobSide } from "@polymarket/clob-client-v2";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import {
  allocatePoolCapital,
  getPolygonProvider,
  syncPoolReturnedCapital,
} from "../onchain/polygonV2";
import { createPoolClobClient } from "./poolClobClient";
import { createPoolRelayClient } from "./poolAccountService";
import { baseUnitsToDecimal, decimalToBaseUnits, decimalToSdkNumber } from "./money";
import { createPolymarketSigner } from "./remoteSigner";
import { assertPolymarketVaultDirectSupported } from "./constants";

const erc20Abi = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
] as const;

function tickAlignedCeiling(value: number, tick: string) {
  const tickNumber = Number(tick);
  const places = (tick.split(".")[1] ?? "").length;
  return Number((Math.ceil((value - Number.EPSILON) / tickNumber) * tickNumber).toFixed(places));
}

function responseOrderId(response: any): string | null {
  return response?.orderID ?? response?.orderId ?? response?.id ?? null;
}

export async function returnIdlePusdToVault(env: Env, poolId: string) {
  const account = await prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
  if (!account) throw new Error("Pool Polymarket account not found");
  const pUSD = new Contract(env.POLYMARKET_PUSD_ADDRESS, erc20Abi, getPolygonProvider(env));
  const balance = (await (pUSD as any).balanceOf(account.depositWalletAddress)) as bigint;
  if (balance === 0n) return { amountBaseUnits: "0", relayerTransactionHash: null, syncTxHash: null };

  const signer = createPolymarketSigner(env, poolId, {
    ownerAddress: account.cdpOwnerAddress,
    depositWalletAddress: account.depositWalletAddress,
    vaultAddress: account.vaultAddress,
  });
  const relay = createPoolRelayClient(env, signer);
  const data = pUSD.interface.encodeFunctionData("transfer", [account.vaultAddress, balance]);
  const transaction = await relay.executeDepositWalletBatch(
    [{ target: env.POLYMARKET_PUSD_ADDRESS, value: "0", data }],
    account.depositWalletAddress,
    String(Math.floor(Date.now() / 1000) + 10 * 60),
  );
  const mined = await transaction.wait();
  if (!mined || ["STATE_FAILED", "STATE_INVALID"].includes(mined.state)) {
    throw new Error("Returning idle pUSD from Deposit Wallet failed");
  }
  const syncTxHash = await syncPoolReturnedCapital(env, account.vaultAddress);
  await prisma.pool_capital_movements.upsert({
    where: { idempotencyKey: `return:${transaction.transactionID}` },
    create: {
      poolId,
      idempotencyKey: `return:${transaction.transactionID}`,
      type: "RETURN",
      amount: baseUnitsToDecimal(balance),
      txHash: mined.transactionHash,
      status: "CONFIRMED",
      rawJson: { relayerTransactionId: transaction.transactionID, syncTxHash },
    },
    update: {},
  });
  return { amountBaseUnits: balance.toString(), relayerTransactionHash: mined.transactionHash, syncTxHash };
}

export async function executeNextTradeIntent(env: Env, workerId: string) {
  assertPolymarketVaultDirectSupported("Polymarket trade execution");
  const next = await prisma.pool_trade_intents.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!next) return null;
  const claimed = await prisma.pool_trade_intents.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "FUNDING", lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return null;
  return executeClaimedTradeIntent(env, next.id);
}

export async function executeClaimedTradeIntent(env: Env, intentId: string) {
  const intent = await prisma.pool_trade_intents.findUnique({ where: { id: intentId } });
  if (!intent || intent.status !== "FUNDING") throw new Error("Trade intent is not claimed for funding");
  const account = await prisma.pool_polymarket_accounts.findUnique({ where: { poolId: intent.poolId } });
  if (!account || account.status !== "READY" || !account.approvalsReady) {
    throw new Error("Pool Deposit Wallet is not ready for trading");
  }

  const fundingKey = `fund:${intent.id}`;
  const fundingAmount = decimalToBaseUnits(intent.reservedPusd.toString());
  await prisma.pool_capital_movements.upsert({
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
    const fundingTxHash = await allocatePoolCapital(
      env,
      account.vaultAddress,
      intent.proposalHash,
      fundingAmount,
    );
    await prisma.$transaction([
      prisma.pool_capital_movements.update({
        where: { idempotencyKey: fundingKey },
        data: { txHash: fundingTxHash, status: "CONFIRMED" },
      }),
      prisma.pool_trade_intents.update({
        where: { id: intent.id },
        data: { status: "FUNDED", metadataJson: { fundingTxHash } },
      }),
    ]);

    const clob = createPoolClobClient(env, account);
    const [tickSize, negRisk, feeRateBps, marketPrice] = await Promise.all([
      clob.getTickSize(intent.tokenId),
      clob.getNegRisk(intent.tokenId),
      clob.getFeeRateBps(intent.tokenId),
      clob.calculateMarketPrice(
        intent.tokenId,
        ClobSide.BUY,
        decimalToSdkNumber(intent.amount.toString(), "order amount"),
        OrderType.FAK,
      ),
    ]);
    const referencePrice = decimalToSdkNumber(intent.limitPrice.toString(), "limit price");
    const cap = Math.min(0.9999, referencePrice * (1 + intent.maxSlippageBps / 10_000));
    if (marketPrice > cap) throw new Error(`Market price ${marketPrice} exceeds slippage cap ${cap}`);
    const orderPrice = tickAlignedCeiling(cap, tickSize);

    await prisma.pool_trade_intents.update({
      where: { id: intent.id },
      data: { status: "SUBMITTING" },
    });
    const response = await clob.createAndPostMarketOrder(
      {
        tokenID: intent.tokenId,
        amount: decimalToSdkNumber(intent.amount.toString(), "order amount"),
        side: ClobSide.BUY,
        price: orderPrice,
        orderType: OrderType.FAK,
        builderCode: env.POLYMARKET_BUILDER_CODE,
      },
      { tickSize, negRisk },
      OrderType.FAK,
    );
    const externalOrderId = responseOrderId(response);
    const status = String(response?.status ?? (response?.success ? "MATCHED" : "SUBMITTED")).toUpperCase();
    const order = await prisma.pool_polymarket_orders.create({
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
    await prisma.pool_trade_intents.update({
      where: { id: intent.id },
      data: { status: "SUBMITTED", lockedAt: null, lockedBy: null },
    });
    const returned = await returnIdlePusdToVault(env, intent.poolId);
    return { intentId: intent.id, orderId: order.id, externalOrderId, status, returned };
  } catch (error: any) {
    const current = await prisma.pool_trade_intents.findUnique({ where: { id: intent.id } });
    const uncertain = current?.status === "SUBMITTING";
    await prisma.pool_trade_intents.update({
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
