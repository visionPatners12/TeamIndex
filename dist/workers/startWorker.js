"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWorker = startWorker;
const bullmq_1 = require("bullmq");
const bull_1 = require("../queues/bull");
const executor_1 = require("../services/executor");
function startWorker({ env, logger }) {
    const concurrency = Number(env.QUEUE_CONCURRENCY || 1);
    const connection = (0, bull_1.buildConnection)(env);
    const worker = new bullmq_1.Worker(bull_1.QUEUE_NAMES.MATCH_EXECUTION, async (job) => {
        const { poolId, candidateId, tranche } = job.data;
        logger.info({ poolId, candidateId, tranche }, "execute job start");
        try {
            await (0, executor_1.executeTranche)({ env, poolId, candidateId, tranche, expectedExecutionTimeMs: job.data.expectedExecutionTimeMs });
            logger.info({ poolId, candidateId, tranche }, "execute job done");
        }
        catch (err) {
            await job.discard();
            await (async () => {
                const { prisma } = await Promise.resolve().then(() => __importStar(require("../db/prisma")));
                await prisma.club_match_queue.updateMany({
                    where: { poolId, candidateId, tranche, status: "SCHEDULED" },
                    data: { status: "FAILED", lastError: String(err?.message ?? err) }
                });
            })();
            throw err;
        }
    }, {
        concurrency,
        connection: connection
    });
    logger.info({ concurrency }, "BullMQ worker started");
    return worker;
}
