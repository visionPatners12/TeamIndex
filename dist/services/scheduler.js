"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleMatchTranches = scheduleMatchTranches;
const prisma_1 = require("../db/prisma");
const bull_1 = require("../queues/bull");
function subtractHours(d, hours) {
    return new Date(d.getTime() - hours * 3600 * 1000);
}
async function scheduleMatchTranches({ poolId, env }) {
    const candidates = await prisma_1.prisma.club_market_candidates.findMany({
        where: { poolId },
        orderBy: { discoveredAt: "desc" }
    });
    for (const c of candidates) {
        if (!c.kickoffTime)
            continue;
        const t48 = subtractHours(c.kickoffTime, 48);
        const t24 = subtractHours(c.kickoffTime, 24);
        // Tranche 1
        const q1 = await prisma_1.prisma.club_match_queue.create({
            data: {
                poolId,
                candidateId: c.id,
                executionTime: t48,
                tranche: 1,
                stakeUsd: 0
            }
        });
        await (0, bull_1.addMatchExecutionJob)(env, { poolId, candidateId: c.id, tranche: 1, expectedExecutionTimeMs: q1.executionTime.getTime() }, q1.executionTime);
        // Tranche 2
        const q2 = await prisma_1.prisma.club_match_queue.create({
            data: {
                poolId,
                candidateId: c.id,
                executionTime: t24,
                tranche: 2,
                stakeUsd: 0
            }
        });
        await (0, bull_1.addMatchExecutionJob)(env, { poolId, candidateId: c.id, tranche: 2, expectedExecutionTimeMs: q2.executionTime.getTime() }, q2.executionTime);
    }
}
