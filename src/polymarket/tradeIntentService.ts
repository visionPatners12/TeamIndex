import { keccak256, parseUnits, toUtf8Bytes } from "ethers";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { activatePoolProposal } from "../onchain/polygonV2";
import { stableJson } from "./stableJson";
import { assertPolymarketVaultDirectSupported } from "./constants";

type ProposalAllocation = {
  conditionId?: string;
  marketId?: string;
  tokenId?: string;
  selectedSide?: "YES" | "NO";
  price?: number;
  allocationAmount?: number;
};

function maxOrder(env: Env) {
  const value = Number(env.POLYMARKET_MAX_ORDER_PUSD);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid POLYMARKET_MAX_ORDER_PUSD");
  return value;
}

function splitAmount(amount: number, limit: number) {
  const chunks: number[] = [];
  let remaining = Math.round(amount * 1_000_000) / 1_000_000;
  while (remaining > 0) {
    const chunk = Math.min(remaining, limit);
    chunks.push(Math.round(chunk * 1_000_000) / 1_000_000);
    remaining = Math.round((remaining - chunk) * 1_000_000) / 1_000_000;
  }
  return chunks;
}

export async function activateAllocationProposalV2(env: Env, poolId: string, proposalId: string) {
  assertPolymarketVaultDirectSupported("Polymarket proposal activation");
  const [pool, proposal, account] = await Promise.all([
    prisma.club_pools.findUnique({ where: { id: poolId } }),
    prisma.pool_allocation_proposals.findUnique({ where: { id: proposalId } }),
    prisma.pool_polymarket_accounts.findUnique({ where: { poolId } }),
  ]);
  if (!pool?.vaultAddress) throw new Error("Pool V2 vault not found");
  if (!proposal || proposal.poolId !== poolId) throw new Error("Allocation proposal not found");
  if (!account || account.status !== "READY") throw new Error("Pool Deposit Wallet is not ready");
  if (!["ACCEPTED", "COMPUTED"].includes(proposal.status)) {
    throw new Error(`Proposal cannot be activated from status ${proposal.status}`);
  }

  const proposalJson = proposal.proposalJson as any;
  const allocations = (Array.isArray(proposalJson?.allocations) ? proposalJson.allocations : []) as ProposalAllocation[];
  if (allocations.length === 0) throw new Error("Proposal contains no executable allocations");

  const selectedRows = await prisma.pool_selected_markets.findMany({ where: { poolId, enabled: true } });
  const selectedByCondition = new Map(selectedRows.map((row) => [row.conditionId, row]));
  const proposalHash = keccak256(
    toUtf8Bytes(stableJson({ poolId, proposalId, proposal: proposal.proposalJson })),
  );
  const intents: Array<{
    conditionId: string;
    tokenId: string;
    side: "YES" | "NO";
    price: number;
    amount: number;
    index: number;
  }> = [];

  for (const allocation of allocations) {
    if (!allocation.conditionId) throw new Error("Allocation is missing conditionId");
    const selected = selectedByCondition.get(allocation.conditionId);
    const tokenId = allocation.tokenId ?? selected?.tokenId;
    const side = allocation.selectedSide ?? selected?.selectedSide;
    const price = Number(allocation.price ?? selected?.yesPrice ?? 0);
    const amount = Number(allocation.allocationAmount ?? 0);
    if (!tokenId || !side || !Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error(`Invalid executable market data for ${allocation.conditionId}`);
    }
    if (!Number.isFinite(amount) || amount <= 0) continue;
    splitAmount(amount, maxOrder(env)).forEach((chunk, index) => {
      intents.push({ conditionId: allocation.conditionId!, tokenId, side, price, amount: chunk, index });
    });
  }
  if (intents.length === 0) throw new Error("Proposal allocates no pUSD");

  const allocationBaseUnits = intents.reduce(
    (sum, intent) => sum + parseUnits(intent.amount.toFixed(6), 6),
    0n,
  );
  const activationTxHash = await activatePoolProposal(
    env,
    pool.vaultAddress,
    proposalHash,
    allocationBaseUnits,
  );

  const created = await prisma.$transaction(async (tx) => {
    await tx.pool_allocation_proposals.update({
      where: { id: proposalId },
      data: { status: "ACTIVE" },
    });
    const rows = [];
    for (const intent of intents) {
      const idempotencyKey = `${proposalId}:${intent.conditionId}:${intent.tokenId}:${intent.index}`;
      rows.push(
        await tx.pool_trade_intents.upsert({
          where: { idempotencyKey },
          create: {
            poolId,
            proposalId,
            idempotencyKey,
            proposalHash,
            conditionId: intent.conditionId,
            tokenId: intent.tokenId,
            side: intent.side,
            orderType: "FAK",
            limitPrice: intent.price.toFixed(6),
            amount: intent.amount.toFixed(6),
            maxSlippageBps: 200,
            reservedPusd: intent.amount.toFixed(6),
            metadataJson: { activationTxHash },
          },
          update: {},
        }),
      );
    }
    return rows;
  });

  return {
    proposalId,
    proposalHash,
    activationTxHash,
    allocationBaseUnits: allocationBaseUnits.toString(),
    intentIds: created.map((intent) => intent.id),
  };
}
