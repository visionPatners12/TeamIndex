import type { Env } from "../config/env";

const CDP_SQL_RUN_URL = "https://api.cdp.coinbase.com/platform/v2/data/query/run";

export type CdpTransferEvent = {
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  args: {
    from?: string;
    to?: string;
    value?: string;
  };
};

type CdpSqlResponse<T> = {
  result?: T[];
  metadata?: {
    rowCount?: number;
    executionTimeMs?: number;
    cached?: boolean;
  };
};

function tokenFromEnv(env: Env) {
  return (env as any).CDP_SQL_API_TOKEN as string | undefined;
}

export function isCdpSqlConfigured(env: Env) {
  return Boolean(tokenFromEnv(env));
}

function assertAddress(address: string) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`Invalid contract address for CDP SQL query: ${address}`);
  }
  return address.toLowerCase();
}

async function runCdpSqlQuery<T>(
  env: Env,
  sql: string,
  cacheMaxAgeMs = 1_000
): Promise<CdpSqlResponse<T>> {
  const token = tokenFromEnv(env);
  if (!token) throw new Error("CDP_SQL_API_TOKEN is not configured");

  const res = await fetch(CDP_SQL_RUN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sql,
      cache: { maxAgeMs: cacheMaxAgeMs }
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CDP SQL API ${res.status}: ${text}`);
  }

  return (await res.json()) as CdpSqlResponse<T>;
}

export async function fetchVaultTransferEventsFromCdpSql({
  env,
  contractAddress,
  fromBlock,
  toBlock,
  limit = 50_000
}: {
  env: Env;
  contractAddress: string;
  fromBlock: number;
  toBlock: number;
  limit?: number;
}): Promise<CdpTransferEvent[]> {
  const address = assertAddress(contractAddress);
  const from = Math.max(0, Math.floor(fromBlock));
  const to = Math.max(from, Math.floor(toBlock));
  const safeLimit = Math.max(1, Math.min(50_000, Math.floor(limit)));

  const sql = `
SELECT
  block_number,
  transaction_hash,
  log_index,
  parameters['from'] AS from_address,
  parameters['to'] AS to_address,
  parameters['value'] AS value
FROM base.events
WHERE event_signature = 'Transfer(address,address,uint256)'
  AND address = '${address}'
  AND block_number >= ${from}
  AND block_number <= ${to}
  AND action = 'added'
ORDER BY block_number ASC, log_index ASC
LIMIT ${safeLimit};
`.trim();

  const response = await runCdpSqlQuery<{
    block_number: string | number;
    transaction_hash: string;
    log_index: string | number;
    from_address?: string;
    to_address?: string;
    value?: string | number;
  }>(env, sql);

  return (response.result ?? []).map((row) => ({
    blockNumber: Number(row.block_number),
    logIndex: Number(row.log_index),
    transactionHash: row.transaction_hash,
    args: {
      from: row.from_address,
      to: row.to_address,
      value: row.value === undefined ? undefined : String(row.value)
    }
  }));
}
