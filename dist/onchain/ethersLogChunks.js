"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogsBlockChunkSize = getLogsBlockChunkSize;
exports.queryFilterInBlockChunks = queryFilterInBlockChunks;
/**
 * Alchemy free tier limits eth_getLogs to a small block window (commonly 10 blocks).
 * Chunk requests so vault sync works without PAYG.
 *
 * Override with ETH_GETLOGS_BLOCK_CHUNK (e.g. 2000 on paid RPCs).
 */
function getLogsBlockChunkSize() {
    const raw = process.env.ETH_GETLOGS_BLOCK_CHUNK;
    const n = raw ? Number(raw) : 10;
    if (!Number.isFinite(n) || n < 1)
        return 10;
    return Math.floor(n);
}
async function queryFilterInBlockChunks(contract, filter, fromBlock, toBlock, chunkSize = getLogsBlockChunkSize()) {
    if (fromBlock > toBlock)
        return [];
    const size = Math.max(1, chunkSize);
    const out = [];
    let start = fromBlock;
    while (start <= toBlock) {
        const end = Math.min(start + size - 1, toBlock);
        const chunk = (await contract.queryFilter(filter, start, end));
        out.push(...chunk);
        start = end + 1;
    }
    return out;
}
