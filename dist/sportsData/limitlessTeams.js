"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertUuid = assertUuid;
exports.listLimitlessTeams = listLimitlessTeams;
exports.getLimitlessMarketsForTeam = getLimitlessMarketsForTeam;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ColumnRow = zod_1.z.object({ table_name: zod_1.z.string(), column_name: zod_1.z.string() });
const TeamRow = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    name: zod_1.z.string().min(1),
    logoUrl: zod_1.z.string().nullable(),
});
async function sportsDataColumns(prisma) {
    const rows = zod_1.z.array(ColumnRow).parse(await prisma.$queryRaw `
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'sports_data'
      and table_name in ('limitless_team', 'limitless_markets', 'teams', 'games')
  `);
    const byTable = new Map();
    for (const row of rows) {
        const set = byTable.get(row.table_name) ?? new Set();
        set.add(row.column_name);
        byTable.set(row.table_name, set);
    }
    return byTable;
}
function requireColumns(columns, table, required) {
    const available = columns.get(table);
    if (!available) {
        throw new Error(`Missing required table sports_data.${table}`);
    }
    const missing = required.filter((column) => !available.has(column));
    if (missing.length) {
        throw new Error(`Missing required sports_data.${table} column(s): ${missing.join(", ")}`);
    }
}
function assertUuid(value, label) {
    if (!UUID_RE.test(value)) {
        throw new Error(`${label} must be a UUID`);
    }
}
async function listLimitlessTeams(prisma) {
    const columns = await sportsDataColumns(prisma);
    requireColumns(columns, "limitless_team", ["team_id", "name"]);
    const hasLogo = columns.get("limitless_team")?.has("logo_url") ?? false;
    const logoSelect = hasLogo
        ? client_1.Prisma.sql `logo_url::text as "logoUrl"`
        : client_1.Prisma.sql `null::text as "logoUrl"`;
    const rows = await prisma.$queryRaw `
    select distinct team_id::text as id, name::text as name, ${logoSelect}
    from sports_data.limitless_team
    where team_id is not null
      and nullif(trim(name::text), '') is not null
    order by name asc
  `;
    return zod_1.z.array(TeamRow).parse(rows);
}
function textValue(row, keys, fallback = "") {
    for (const key of keys) {
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return String(value);
    }
    return fallback;
}
function numberValue(row, keys, fallback = 0) {
    for (const key of keys) {
        const value = row[key];
        if (value === undefined || value === null || value === "")
            continue;
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return fallback;
}
function dateValue(row, keys) {
    for (const key of keys) {
        const value = row[key];
        if (!value)
            continue;
        const d = new Date(String(value));
        if (Number.isFinite(d.getTime()))
            return d.toISOString();
    }
    return null;
}
async function getLimitlessMarketsForTeam(prisma, teamId) {
    assertUuid(teamId, "teamId");
    const columns = await sportsDataColumns(prisma);
    const marketColumns = columns.get("limitless_markets") ?? new Set();
    const gameColumns = columns.get("games") ?? new Set();
    let rows;
    const canJoinGames = marketColumns.has("game_id") &&
        gameColumns.has("id") &&
        gameColumns.has("home_id") &&
        gameColumns.has("away_id");
    if (canJoinGames) {
        rows = (await prisma.$queryRaw `
      select lm.*, g.home_id, g.away_id
      from sports_data.limitless_markets lm
      join sports_data.games g on g.id::text = lm.game_id::text
      where g.home_id::text = ${teamId}
         or g.away_id::text = ${teamId}
    `);
    }
    else {
        requireColumns(columns, "limitless_markets", ["home_id", "away_id"]);
        rows = (await prisma.$queryRaw `
      select lm.*
      from sports_data.limitless_markets lm
      where lm.home_id::text = ${teamId}
         or lm.away_id::text = ${teamId}
    `);
    }
    return rows
        .map((row) => {
        const homeId = row.home_id == null ? null : String(row.home_id);
        const awayId = row.away_id == null ? null : String(row.away_id);
        const sideHint = homeId === teamId ? "HOME" : "AWAY";
        const id = textValue(row, ["id", "slug", "market_id", "marketId"]);
        const title = textValue(row, ["title", "question", "name"], id ? `Market ${id}` : "Untitled market");
        return {
            id,
            title,
            status: textValue(row, ["status"], "ACTIVE"),
            yesPrice: numberValue(row, ["yes_price", "yesPrice", "yes", "price"], 0.5),
            noPrice: numberValue(row, ["no_price", "noPrice", "no"], 0.5),
            liquidity: numberValue(row, ["liquidity", "liquidity_usd", "liquidityUsd"], 0),
            volume: numberValue(row, ["volume", "volume_usd", "volumeUsd"], 0),
            endDate: dateValue(row, ["end_date", "endDate", "game_time", "gameTime", "starts_at", "startsAt"]),
            homeId,
            awayId,
            sideHint,
            raw: row,
        };
    })
        .filter((market) => market.id.length > 0)
        .sort((a, b) => {
        const ad = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
        const bd = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
        if (ad !== bd)
            return ad - bd;
        return b.liquidity - a.liquidity;
    });
}
