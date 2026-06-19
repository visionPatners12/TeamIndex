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
    sport: zod_1.z.string().nullable(),
    country: zod_1.z.string().nullable(),
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
function teamNameSelect(teamColumns) {
    if (teamColumns.has("name"))
        return client_1.Prisma.sql `name::text`;
    if (teamColumns.has("display_name"))
        return client_1.Prisma.sql `display_name::text`;
    if (teamColumns.has("short_name"))
        return client_1.Prisma.sql `short_name::text`;
    throw new Error("Missing required sports_data.teams column(s): one of name, display_name, short_name");
}
function teamLogoSelect(teamColumns) {
    if (teamColumns.has("logo_url"))
        return client_1.Prisma.sql `logo_url::text as "logoUrl"`;
    if (teamColumns.has("image_url"))
        return client_1.Prisma.sql `image_url::text as "logoUrl"`;
    if (teamColumns.has("crest_url"))
        return client_1.Prisma.sql `crest_url::text as "logoUrl"`;
    if (teamColumns.has("logo"))
        return client_1.Prisma.sql `logo::text as "logoUrl"`;
    return client_1.Prisma.sql `null::text as "logoUrl"`;
}
function teamSportSelect(teamColumns) {
    if (teamColumns.has("sport"))
        return client_1.Prisma.sql `sport::text as sport`;
    if (teamColumns.has("sport_name"))
        return client_1.Prisma.sql `sport_name::text as sport`;
    if (teamColumns.has("sport_slug"))
        return client_1.Prisma.sql `sport_slug::text as sport`;
    if (teamColumns.has("sport_key"))
        return client_1.Prisma.sql `sport_key::text as sport`;
    return client_1.Prisma.sql `null::text as sport`;
}
function teamCountrySelect(teamColumns) {
    if (teamColumns.has("country"))
        return client_1.Prisma.sql `country::text as country`;
    if (teamColumns.has("country_name"))
        return client_1.Prisma.sql `country_name::text as country`;
    if (teamColumns.has("country_code"))
        return client_1.Prisma.sql `country_code::text as country`;
    if (teamColumns.has("country_iso2"))
        return client_1.Prisma.sql `country_iso2::text as country`;
    if (teamColumns.has("country_iso3"))
        return client_1.Prisma.sql `country_iso3::text as country`;
    return client_1.Prisma.sql `null::text as country`;
}
function assertUuid(value, label) {
    if (!UUID_RE.test(value)) {
        throw new Error(`${label} must be a UUID`);
    }
}
async function listLimitlessTeams(prisma) {
    const columns = await sportsDataColumns(prisma);
    requireColumns(columns, "teams", ["id"]);
    const teamColumns = columns.get("teams") ?? new Set();
    const nameSelect = teamNameSelect(teamColumns);
    const logoSelect = teamLogoSelect(teamColumns);
    const sportSelect = teamSportSelect(teamColumns);
    const countrySelect = teamCountrySelect(teamColumns);
    const rows = await prisma.$queryRaw `
    select distinct id::text as id, ${nameSelect} as name, ${sportSelect}, ${countrySelect}, ${logoSelect}
    from sports_data.teams
    where id is not null
      and nullif(trim(${nameSelect}), '') is not null
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
function normalizeTeamName(name) {
    return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}
async function getSportsDataTeamName(prisma, teamId, columns) {
    requireColumns(columns, "teams", ["id"]);
    const teamColumns = columns.get("teams") ?? new Set();
    const nameSelect = teamNameSelect(teamColumns);
    const rows = (await prisma.$queryRaw `
    select ${nameSelect} as name
    from sports_data.teams
    where id::text = ${teamId}
    limit 1
  `);
    const name = rows[0]?.name?.trim();
    if (!name)
        throw new Error(`sports_data.teams row not found for ${teamId}`);
    return name;
}
function mapRowsToMarkets(rows, teamId) {
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
async function getCachedLimitlessMarketsForTeam(prisma, teamId, columns) {
    const teamName = await getSportsDataTeamName(prisma, teamId, columns);
    const normalizedTeamName = normalizeTeamName(teamName);
    const games = await prisma.lim_games.findMany({
        include: { market: true },
        orderBy: { gameTime: "asc" },
        take: 1000,
    });
    const rows = [];
    for (const game of games) {
        const homeName = game.homeTeam == null ? "" : String(game.homeTeam);
        const awayName = game.awayTeam == null ? "" : String(game.awayTeam);
        const homeMatches = normalizeTeamName(homeName) === normalizedTeamName;
        const awayMatches = normalizeTeamName(awayName) === normalizedTeamName;
        if (!homeMatches && !awayMatches)
            continue;
        const market = game.market ?? {};
        rows.push({
            id: market.id,
            title: market.title,
            status: market.status,
            yesPrice: market.yesPrice,
            noPrice: market.noPrice,
            liquidity: market.liquidity,
            volume: market.volume,
            endDate: market.endDate,
            home_id: homeMatches ? teamId : null,
            away_id: awayMatches ? teamId : null,
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            sport: game.sport,
            league: game.league,
            gameTime: game.gameTime,
            rawJson: market.rawJson ?? game.rawJson,
        });
    }
    return mapRowsToMarkets(rows, teamId);
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
    else if (marketColumns.has("home_id") && marketColumns.has("away_id")) {
        requireColumns(columns, "limitless_markets", ["home_id", "away_id"]);
        rows = (await prisma.$queryRaw `
      select lm.*
      from sports_data.limitless_markets lm
      where lm.home_id::text = ${teamId}
         or lm.away_id::text = ${teamId}
    `);
    }
    else {
        return getCachedLimitlessMarketsForTeam(prisma, teamId, columns);
    }
    return mapRowsToMarkets(rows, teamId);
}
