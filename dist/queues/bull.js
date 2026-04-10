"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUEUE_NAMES = void 0;
exports.buildConnection = buildConnection;
exports.buildQueue = buildQueue;
exports.addMatchExecutionJob = addMatchExecutionJob;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
exports.QUEUE_NAMES = {
    MATCH_EXECUTION: "match_execution"
};
function buildConnection(env) {
    if (!env.REDIS_URL) {
        throw new Error("REDIS_URL missing. Set Railway Redis URL or disable worker by leaving REDIS_URL empty.");
    }
    // BullMQ requires `maxRetriesPerRequest` to be `null` for blocking clients.
    // ioredis defaults can vary by version, so set explicitly.
    return new ioredis_1.default(env.REDIS_URL, { maxRetriesPerRequest: null });
}
function buildQueue(env) {
    const connection = buildConnection(env);
    // `ioredis` can be installed as a transitive dependency via `bullmq`,
    // causing TS type mismatch across versions. Cast to avoid compile-time friction.
    return new bullmq_1.Queue(exports.QUEUE_NAMES.MATCH_EXECUTION, { connection: connection });
}
async function addMatchExecutionJob(env, data, runAt) {
    const queue = buildQueue(env);
    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    await queue.add("execute", data, {
        delay: delayMs
    });
    await queue.close();
}
