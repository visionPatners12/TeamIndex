"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCdpSqlConfigured = isCdpSqlConfigured;
exports.fetchVaultTransferEventsFromCdpSql = fetchVaultTransferEventsFromCdpSql;
const CDP_SQL_RUN_URL = "https://api.cdp.coinbase.com/platform/v2/data/query/run";
function tokenFromEnv(env) {
    return env.CDP_SQL_API_TOKEN;
}
function isCdpSqlConfigured(env) {
    return Boolean(tokenFromEnv(env));
}
function assertAddress(address) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        throw new Error(`Invalid contract address for CDP SQL query: ${address}`);
    }
    return address.toLowerCase();
}
async function runCdpSqlQuery(env, sql, cacheMaxAgeMs = 1_000) {
    const token = tokenFromEnv(env);
    if (!token)
        throw new Error("CDP_SQL_API_TOKEN is not configured");
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
    return (await res.json());
}
async function fetchVaultTransferEventsFromCdpSql({ env, contractAddress, fromBlock, toBlock, limit = 50_000 }) {
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
    const response = await runCdpSqlQuery(env, sql);
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
