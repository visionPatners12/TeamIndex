import type { Contract, EventLog } from "ethers";

/**
 * Alchemy free tier limits eth_getLogs to a small block window (commonly 10 blocks).
 * Chunk requests so vault sync works without PAYG.
 *
 * Override with ETH_GETLOGS_BLOCK_CHUNK (e.g. 2000 on paid RPCs).
 */
export function getLogsBlockChunkSize(): number {
  const raw = process.env.ETH_GETLOGS_BLOCK_CHUNK;
  const n = raw ? Number(raw) : 10;
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.floor(n);
}

export async function queryFilterInBlockChunks(
  contract: Contract,
  filter: Parameters<Contract["queryFilter"]>[0],
  fromBlock: number,
  toBlock: number,
  chunkSize = getLogsBlockChunkSize()
): Promise<EventLog[]> {
  if (fromBlock > toBlock) return [];
  const size = Math.max(1, chunkSize);
  const out: EventLog[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + size - 1, toBlock);
    const chunk = (await contract.queryFilter(filter, start, end)) as EventLog[];
    out.push(...chunk);
    start = end + 1;
  }
  return out;
}
