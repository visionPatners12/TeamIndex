import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ColumnRow = z.object({
  table_schema: z.string(),
  table_name: z.string(),
  column_name: z.string(),
});

const TeamRow = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  sport: z.string().nullable(),
  country: z.string().nullable(),
  logoUrl: z.string().nullable(),
  limitlessMarketsCount: z.number().int().nonnegative().optional(),
});

export type SportsDataTeam = z.infer<typeof TeamRow>;

export type SportsDataMarket = {
  id: string;
  conditionId: string | null;
  title: string;
  status: string | null;
  yesPrice: number;
  noPrice: number;
  liquidity: number;
  volume: number;
  endDate: string | null;
  homeId: string | null;
  awayId: string | null;
  sideHint: "HOME" | "AWAY";
  // ─ Grouping: match (game) → market (market group) → outcome ─
  gameId: string | null;
  gameLabel: string | null;
  gameStartsAt: string | null;
  gameState: string | null;
  leagueName: string | null;
  marketGroupId: string | null;
  marketGroupTitle: string | null;
  marketKind: string | null;
  outcomeIndex: number | null;
  raw: Record<string, unknown>;
};

async function sportsDataColumns(prisma: PrismaClient) {
  const rows = z.array(ColumnRow).parse(await prisma.$queryRaw`
    select table_schema, table_name, column_name
    from information_schema.columns
    where (
        table_schema = 'sports_data'
        and table_name in ('teams', 'games')
      )
      or (
        table_schema = 'limitless'
        and table_name in ('market_entity_links', 'market_groups', 'markets')
      )
  `);

  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const qualifiedName = `${row.table_schema}.${row.table_name}`;
    const names = row.table_schema === "sports_data"
      ? [row.table_name, qualifiedName]
      : [qualifiedName];
    for (const name of names) {
      const set = byTable.get(name) ?? new Set<string>();
      set.add(row.column_name);
      byTable.set(name, set);
    }
  }
  return byTable;
}

function requireColumns(columns: Map<string, Set<string>>, table: string, required: string[]) {
  const available = columns.get(table);
  if (!available) {
    throw new Error(`Missing required table sports_data.${table}`);
  }
  const missing = required.filter((column) => !available.has(column));
  if (missing.length) {
    throw new Error(`Missing required sports_data.${table} column(s): ${missing.join(", ")}`);
  }
}

function isMissingRelationError(err: unknown) {
  const e = err as any;
  const text = [
    e?.code,
    e?.meta?.code,
    e?.message,
    e?.meta?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("42p01") ||
    text.includes("42703") ||
    text.includes("does not exist") ||
    text.includes("undefined_table") ||
    text.includes("undefined_column");
}

function teamNameSelect(teamColumns: Set<string>) {
  if (teamColumns.has("name")) return Prisma.sql`name::text`;
  if (teamColumns.has("display_name")) return Prisma.sql`display_name::text`;
  if (teamColumns.has("short_name")) return Prisma.sql`short_name::text`;
  throw new Error("Missing required sports_data.teams column(s): one of name, display_name, short_name");
}

function teamLogoSelect(teamColumns: Set<string>) {
  if (teamColumns.has("logo_url")) return Prisma.sql`logo_url::text as "logoUrl"`;
  if (teamColumns.has("image_url")) return Prisma.sql`image_url::text as "logoUrl"`;
  if (teamColumns.has("crest_url")) return Prisma.sql`crest_url::text as "logoUrl"`;
  if (teamColumns.has("logo")) return Prisma.sql`logo::text as "logoUrl"`;
  return Prisma.sql`null::text as "logoUrl"`;
}

function teamSportSelect(teamColumns: Set<string>) {
  if (teamColumns.has("sport")) return Prisma.sql`sport::text as sport`;
  if (teamColumns.has("sport_name")) return Prisma.sql`sport_name::text as sport`;
  if (teamColumns.has("sport_slug")) return Prisma.sql`sport_slug::text as sport`;
  if (teamColumns.has("sport_key")) return Prisma.sql`sport_key::text as sport`;
  return Prisma.sql`null::text as sport`;
}

function teamCountrySelect(teamColumns: Set<string>) {
  if (teamColumns.has("country")) return Prisma.sql`country::text as country`;
  if (teamColumns.has("country_name")) return Prisma.sql`country_name::text as country`;
  if (teamColumns.has("country_code")) return Prisma.sql`country_code::text as country`;
  if (teamColumns.has("country_iso2")) return Prisma.sql`country_iso2::text as country`;
  if (teamColumns.has("country_iso3")) return Prisma.sql`country_iso3::text as country`;
  return Prisma.sql`null::text as country`;
}

export function assertUuid(value: string, label: string) {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

async function getLegacyLimitlessTeamCounts(prisma: PrismaClient) {
  return (await prisma.$queryRaw`
    select team_id::text as id, count(*)::int as "limitlessMarketsCount"
    from (
      select lg."homeSportsDataTeamId" as team_id, lg."marketId" as market_id
      from "lim_games" lg
      join "limitless_markets" lm on lm.id = lg."marketId"
      where lg."homeSportsDataTeamId" is not null
        and upper(coalesce(lm.status, 'ACTIVE')) = 'ACTIVE'
      union all
      select lg."awaySportsDataTeamId" as team_id, lg."marketId" as market_id
      from "lim_games" lg
      join "limitless_markets" lm on lm.id = lg."marketId"
      where lg."awaySportsDataTeamId" is not null
        and upper(coalesce(lm.status, 'ACTIVE')) = 'ACTIVE'
    ) linked
    where team_id is not null
    group by team_id
  `) as Array<{ id: string; limitlessMarketsCount: number }>;
}

async function getLimitlessTeamCountsFromEntityLinks(prisma: PrismaClient) {
  return (await prisma.$queryRaw`
    with linked as (
      select
        mel.home_team_id as team_id,
        coalesce(mk.id::text, mg.group_id::text) as market_key
      from limitless.market_entity_links mel
      left join limitless.market_groups mg on mg.group_id = mel.market_group_id
      left join limitless.markets mk on mk.group_id = mg.group_id
      where mel.entity_type = 'team'
        and mel.role = 'fixture_teams'
        and mel.home_team_id is not null
        and upper(coalesce(mk.status, mg.status, '')) <> 'RESOLVED'
        and coalesce(mk.hidden, false) = false
      union all
      select
        mel.away_team_id as team_id,
        coalesce(mk.id::text, mg.group_id::text) as market_key
      from limitless.market_entity_links mel
      left join limitless.market_groups mg on mg.group_id = mel.market_group_id
      left join limitless.markets mk on mk.group_id = mg.group_id
      where mel.entity_type = 'team'
        and mel.role = 'fixture_teams'
        and mel.away_team_id is not null
        and upper(coalesce(mk.status, mg.status, '')) <> 'RESOLVED'
        and coalesce(mk.hidden, false) = false
    )
    select team_id::text as id, count(distinct market_key)::int as "limitlessMarketsCount"
    from linked
    where team_id is not null
      and market_key is not null
    group by team_id
  `) as Array<{ id: string; limitlessMarketsCount: number }>;
}

export async function listLimitlessTeams(
  prisma: PrismaClient,
  options?: { onlyWithLimitlessMarkets?: boolean }
): Promise<SportsDataTeam[]> {
  const columns = await sportsDataColumns(prisma);
  requireColumns(columns, "teams", ["id"]);
  const teamColumns = columns.get("teams") ?? new Set<string>();
  const nameSelect = teamNameSelect(teamColumns);
  const logoSelect = teamLogoSelect(teamColumns);
  const sportSelect = teamSportSelect(teamColumns);
  const countrySelect = teamCountrySelect(teamColumns);

  const rows = await prisma.$queryRaw`
    select distinct id::text as id, ${nameSelect} as name, ${sportSelect}, ${countrySelect}, ${logoSelect}
    from sports_data.teams
    where id is not null
      and nullif(trim(${nameSelect}), '') is not null
    order by name asc
  `;

  const teams = z.array(TeamRow).parse(rows);
  if (!options?.onlyWithLimitlessMarkets) return teams;

  let linkedRows: Array<{ id: string; limitlessMarketsCount: number }>;
  try {
    linkedRows = await getLimitlessTeamCountsFromEntityLinks(prisma);
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    linkedRows = await getLegacyLimitlessTeamCounts(prisma);
  }

  const countByTeamId = new Map(linkedRows.map((row) => [row.id, row.limitlessMarketsCount]));
  return teams
    .filter((team) => countByTeamId.has(team.id))
    .map((team) => ({
      ...team,
      limitlessMarketsCount: countByTeamId.get(team.id) ?? 0,
    }));
}

function textValue(row: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  return fallback;
}

function numberValue(row: Record<string, unknown>, keys: string[], fallback = 0) {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function dateValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (!value) continue;
    const d = new Date(String(value));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return null;
}

function normalizeTeamName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedContainsTeam(value: unknown, normalizedTeamName: string) {
  if (!value || !normalizedTeamName) return false;
  const normalized = normalizeTeamName(typeof value === "string" ? value : JSON.stringify(value));
  if (!normalized) return false;
  return normalized === normalizedTeamName ||
    normalized.startsWith(`${normalizedTeamName} `) ||
    normalized.endsWith(` ${normalizedTeamName}`) ||
    normalized.includes(` ${normalizedTeamName} `);
}

function sideHintFromText(value: unknown, normalizedTeamName: string): "HOME" | "AWAY" | null {
  if (!value || !normalizedTeamName) return null;
  const normalized = normalizeTeamName(String(value));
  if (normalized.startsWith(`${normalizedTeamName} vs `) || normalized.startsWith(`${normalizedTeamName} v `)) {
    return "HOME";
  }
  if (normalized.includes(` vs ${normalizedTeamName}`) || normalized.includes(` v ${normalizedTeamName}`)) {
    return "AWAY";
  }
  return null;
}

async function getSportsDataTeamName(
  prisma: PrismaClient,
  teamId: string,
  columns: Map<string, Set<string>>
) {
  requireColumns(columns, "teams", ["id"]);
  const teamColumns = columns.get("teams") ?? new Set<string>();
  const nameSelect = teamNameSelect(teamColumns);
  const rows = (await prisma.$queryRaw`
    select ${nameSelect} as name
    from sports_data.teams
    where id::text = ${teamId}
    limit 1
  `) as Array<{ name: string | null }>;

  const name = rows[0]?.name?.trim();
  if (!name) throw new Error(`sports_data.teams row not found for ${teamId}`);
  return name;
}

function mapRowsToMarkets(rows: Array<Record<string, unknown>>, teamId: string): SportsDataMarket[] {
  // Derive a match label per game: player-prop groups have null team names but
  // share the same game_id with a fixture group that does carry the names.
  const gameLabelById = new Map<string, string>();
  for (const row of rows) {
    const gameId = textValue(row, ["game_id", "gameId"]);
    if (!gameId || gameLabelById.has(gameId)) continue;
    const home = textValue(row, ["home_team_name", "homeTeam"]);
    const away = textValue(row, ["away_team_name", "awayTeam"]);
    if (home && away) gameLabelById.set(gameId, `${home} vs ${away}`);
  }

  return rows
    .map((row) => {
      const homeId = row.home_id == null ? null : String(row.home_id);
      const awayId = row.away_id == null ? null : String(row.away_id);
      const sideHint = row.side_hint === "HOME" || row.side_hint === "AWAY"
        ? row.side_hint
        : homeId === teamId ? "HOME" : "AWAY";
      const id = textValue(row, ["id", "slug", "market_id", "marketId"]);
      const title = textValue(row, ["title", "question", "name"], id ? `Market ${id}` : "Untitled market");

      const gameId = textValue(row, ["game_id", "gameId"]) || null;
      const marketGroupTitle = textValue(row, ["market_group_title", "marketGroupTitle"]) || null;
      const gameLabel = (gameId && gameLabelById.get(gameId)) || marketGroupTitle || null;
      const outcomeIndexRaw = row.outcome_index ?? row.outcomeIndex;
      const outcomeIndex = outcomeIndexRaw == null || outcomeIndexRaw === ""
        ? null
        : Number(outcomeIndexRaw);

      return {
        id,
        conditionId: textValue(row, ["condition_id", "conditionId"]) || null,
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
        gameId,
        gameLabel,
        gameStartsAt: dateValue(row, ["starts_at", "startsAt", "game_time", "gameTime", "end_date"]),
        gameState: textValue(row, ["game_state", "gameState", "state"]) || null,
        leagueName: textValue(row, ["league_name", "leagueName", "league"]) || null,
        marketGroupId: textValue(row, ["market_group_id", "marketGroupId"]) || null,
        marketGroupTitle,
        marketKind: textValue(row, ["lim_market_type", "limMarketType", "market_type"]) || null,
        outcomeIndex: Number.isFinite(outcomeIndex as number) ? (outcomeIndex as number) : null,
        raw: row,
      } satisfies SportsDataMarket;
    })
    .filter((market) => market.id.length > 0)
    .sort((a, b) => {
      const ad = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
      const bd = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      // Keep markets of the same match/group together, outcomes in index order.
      const ag = a.gameId ?? "", bg = b.gameId ?? "";
      if (ag !== bg) return ag < bg ? -1 : 1;
      const amg = a.marketGroupId ?? "", bmg = b.marketGroupId ?? "";
      if (amg !== bmg) return amg < bmg ? -1 : 1;
      const ao = a.outcomeIndex ?? Number.POSITIVE_INFINITY;
      const bo = b.outcomeIndex ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return b.liquidity - a.liquidity;
    });
}

async function getCachedLimitlessMarketsForTeam(
  prisma: PrismaClient,
  teamId: string,
  columns: Map<string, Set<string>>
): Promise<SportsDataMarket[]> {
  const teamName = await getSportsDataTeamName(prisma, teamId, columns);
  const normalizedTeamName = normalizeTeamName(teamName);
  const games = await (prisma as any).lim_games.findMany({
    include: { market: true },
    orderBy: { gameTime: "asc" },
    take: 1000,
  });

  const rows: Array<Record<string, unknown>> = [];
  const seenMarketIds = new Set<string>();
  for (const game of games as any[]) {
    const homeName = game.homeTeam == null ? "" : String(game.homeTeam);
    const awayName = game.awayTeam == null ? "" : String(game.awayTeam);
    const market = game.market ?? {};
    const linkedHomeMatches = game.homeSportsDataTeamId && String(game.homeSportsDataTeamId) === teamId;
    const linkedAwayMatches = game.awaySportsDataTeamId && String(game.awaySportsDataTeamId) === teamId;
    const homeMatches = linkedHomeMatches || normalizedContainsTeam(homeName, normalizedTeamName);
    const awayMatches = linkedAwayMatches || normalizedContainsTeam(awayName, normalizedTeamName);
    const textSideHint =
      sideHintFromText(game.marketId, normalizedTeamName) ??
      sideHintFromText(market.id, normalizedTeamName) ??
      sideHintFromText(market.title, normalizedTeamName);
    const textMatches =
      normalizedContainsTeam(game.marketId, normalizedTeamName) ||
      normalizedContainsTeam(market.id, normalizedTeamName) ||
      normalizedContainsTeam(market.title, normalizedTeamName) ||
      normalizedContainsTeam(market.rawJson, normalizedTeamName) ||
      normalizedContainsTeam(game.rawJson, normalizedTeamName);
    if (!homeMatches && !awayMatches && !textMatches) continue;

    const marketId = String(market.id ?? game.marketId ?? "");
    if (marketId && seenMarketIds.has(marketId)) continue;
    if (marketId) seenMarketIds.add(marketId);
    rows.push({
      id: market.id,
      title: market.title,
      status: market.status,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      liquidity: market.liquidity,
      volume: market.volume,
      endDate: market.endDate,
      home_id: homeMatches || textSideHint === "HOME" ? teamId : null,
      away_id: awayMatches || textSideHint === "AWAY" ? teamId : null,
      side_hint: homeMatches || textSideHint === "HOME" ? "HOME" : "AWAY",
      sports_data_game_id: game.sportsDataGameId,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      sport: game.sport,
      league: game.league,
      gameTime: game.gameTime,
      rawJson: market.rawJson ?? game.rawJson,
    });
  }

  const search = `%${normalizedTeamName.replace(/\s+/g, "%")}%`;
  const directMarkets = (await prisma.$queryRaw`
    select
      lm."id",
      lm."title",
      lm."status",
      lm."yesPrice",
      lm."noPrice",
      lm."liquidity",
      lm."volume",
      lm."endDate",
      lm."rawJson"
    from "limitless_markets" lm
    where lower(lm."id") like ${search}
       or lower(lm."title") like ${search}
       or lower(coalesce(lm."rawJson"::text, '')) like ${search}
    order by lm."endDate" asc nulls last, lm."liquidity" desc
    limit 1000
  `) as Array<Record<string, unknown>>;

  for (const market of directMarkets) {
    const marketId = String(market.id ?? "");
    if (!marketId || seenMarketIds.has(marketId)) continue;

    const textSideHint =
      sideHintFromText(market.id, normalizedTeamName) ??
      sideHintFromText(market.title, normalizedTeamName) ??
      sideHintFromText(market.rawJson, normalizedTeamName);

    seenMarketIds.add(marketId);
    rows.push({
      ...market,
      home_id: textSideHint === "HOME" ? teamId : null,
      away_id: textSideHint === "AWAY" ? teamId : null,
      side_hint: textSideHint ?? "HOME",
    });
  }

  return mapRowsToMarkets(rows, teamId);
}

async function getEntityLinkedLimitlessMarketsForTeam(
  prisma: PrismaClient,
  teamId: string
): Promise<SportsDataMarket[]> {
  const rows = (await prisma.$queryRaw`
    with linked_groups as (
      select distinct
        mel.market_group_id as group_id,
        mel.home_team_id,
        mel.away_team_id,
        case
          when mel.home_team_id::text = ${teamId} then 'HOME'
          else 'AWAY'
        end as side_hint
      from limitless.market_entity_links mel
      where mel.entity_type = 'team'
        and mel.role = 'fixture_teams'
        and mel.market_group_id is not null
        and (
          mel.home_team_id::text = ${teamId}
          or mel.away_team_id::text = ${teamId}
        )
    )
    select
      mk.id::text as id,
      mk.condition_id::text as condition_id,
      coalesce(mk.title, mg.title, mk.slug, mg.slug, mk.id::text, mg.group_id::text) as title,
      coalesce(mk.status, mg.status, 'ACTIVE') as status,
      coalesce(mk.prices[1], 0.5)::float8 as yes_price,
      coalesce(mk.prices[2], case when mk.prices[1] is null then 0.5 else 1 - mk.prices[1] end)::float8 as no_price,
      0::float8 as liquidity,
      coalesce(mk.volume, mg.volume, 0)::float8 as volume,
      coalesce(g.starts_at, mg.start_match_at)::timestamptz as end_date,
      lg.home_team_id::text as home_id,
      lg.away_team_id::text as away_id,
      lg.side_hint,
      mg.group_id::text as market_group_id,
      mg.slug as market_group_slug,
      mg.title as market_group_title,
      mg.home_team_name,
      mg.away_team_name,
      mg.sport_slug,
      mg.league_name,
      mg.lim_market_type,
      mg.game_id::text as game_id,
      g.starts_at,
      g.state::text as game_state,
      g.home_score,
      g.away_score,
      mk.slug as market_slug,
      mk.outcome_index,
      mk.prices,
      mk.yes_token,
      mk.no_token,
      mk.raw
    from linked_groups lg
    join limitless.market_groups mg on mg.group_id = lg.group_id
    join limitless.markets mk on mk.group_id = mg.group_id
    left join sports_data.games g on g.id = mg.game_id
    where upper(coalesce(mk.status, mg.status, '')) <> 'RESOLVED'
      and coalesce(mk.hidden, false) = false
    order by coalesce(g.starts_at, mg.start_match_at) asc nulls last,
             coalesce(mk.volume, mg.volume, 0) desc,
             mk.outcome_index asc nulls last,
             mk.id asc
  `) as Array<Record<string, unknown>>;

  return mapRowsToMarkets(rows, teamId);
}

export async function getLimitlessMarketsForTeam(
  prisma: PrismaClient,
  teamId: string
): Promise<SportsDataMarket[]> {
  assertUuid(teamId, "teamId");
  const columns = await sportsDataColumns(prisma);

  try {
    return await getEntityLinkedLimitlessMarketsForTeam(prisma, teamId);
  } catch (err) {
    if (isMissingRelationError(err)) {
      return getCachedLimitlessMarketsForTeam(prisma, teamId, columns);
    }
    throw err;
  }
}
