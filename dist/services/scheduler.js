"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleMatchTranches = scheduleMatchTranches;
const prisma_1 = require("../db/prisma");
const bull_1 = require("../queues/bull");
function subtractHours(d, hours) {
    return new Date(d.getTime() - hours * 3600 * 1000);
}
const TERMINAL_QUEUE_STATUSES = new Set(["EXECUTED", "SKIPPED", "CANCELLED", "PROCESSING"]);
async function scheduleCandidateTranche(params) {
    const existing = await prisma_1.prisma.club_match_queue.findUnique({
        where: {
            poolId_candidateId_tranche: {
                poolId: params.poolId,
                candidateId: params.candidateId,
                tranche: params.tranche
            }
        }
    });
    if (existing && TERMINAL_QUEUE_STATUSES.has(existing.status)) {
        return "skipped";
    }
    const queueRow = existing
        ? await prisma_1.prisma.club_match_queue.update({
            where: { id: existing.id },
            data: {
                executionTime: params.executionTime,
                stakeUsd: params.stakeUsd,
                status: "SCHEDULED",
                lockedAt: null,
                lockedBy: null,
                executedAt: null,
                lastError: null
            }
        })
        : await prisma_1.prisma.club_match_queue.create({
            data: {
                poolId: params.poolId,
                candidateId: params.candidateId,
                executionTime: params.executionTime,
                tranche: params.tranche,
                stakeUsd: params.stakeUsd
            }
        });
    await (0, bull_1.addMatchExecutionJob)(params.env, {
        queueId: queueRow.id,
        poolId: params.poolId,
        candidateId: params.candidateId,
        tranche: params.tranche,
        expectedExecutionTimeMs: queueRow.executionTime.getTime()
    }, queueRow.executionTime);
    return existing ? "updated" : "created";
}
async function scheduleMatchTranches({ poolId, env }) {
    const result = {
        created: 0,
        updated: 0,
        skipped: 0,
        jobsQueued: 0
    };
    const candidates = await prisma_1.prisma.club_market_candidates.findMany({
        where: { poolId },
        orderBy: { discoveredAt: "desc" }
    });
    for (const c of candidates) {
        if (!c.kickoffTime)
            continue;
        const t48 = subtractHours(c.kickoffTime, 48);
        const t24 = subtractHours(c.kickoffTime, 24);
        const r1 = await scheduleCandidateTranche({
            env,
            poolId,
            candidateId: c.id,
            executionTime: t48,
            tranche: 1,
            stakeUsd: "0"
        });
        result[r1] += 1;
        if (r1 !== "skipped")
            result.jobsQueued += 1;
        const r2 = await scheduleCandidateTranche({
            env,
            poolId,
            candidateId: c.id,
            executionTime: t24,
            tranche: 2,
            stakeUsd: "0"
        });
        result[r2] += 1;
        if (r2 !== "skipped")
            result.jobsQueued += 1;
    }
    return result;
}
