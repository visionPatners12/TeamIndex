import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ColumnRow = z.object({ table_name: z.string(), column_name: z.string() });

const TeamRow = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  logoUrl: z.string().nullable(),
});

export type SportsDataTeam = z.infer<typeof TeamRow>;

export type SportsDataMarket = {
  id: string;
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
  raw: Record<string, unknown>;
};

async function sportsDataColumns(prisma: PrismaClient) {
  const rows = z.array(ColumnRow).parse(await prisma.$queryRaw`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'sports_data'
      and table_name in ('limitless_team', 'limitless_markets', 'teams', 'games')
  `);

  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byTable.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    byTable.set(row.table_name, set);
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
  return Prisma.sql`null::text as "logoUrl"`;
}

export function assertUuid(value: string, label: string) {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

export async function listLimitlessTeams(prisma: PrismaClient): Promise<SportsDataTeam[]> {
  const columns = await sportsDataColumns(prisma);
  requireColumns(columns, "teams", ["id"]);
  const teamColumns = columns.get("teams") ?? new Set<string>();
  const nameSelect = teamNameSelect(teamColumns);
  const logoSelect = teamLogoSelect(teamColumns);

  const rows = await prisma.$queryRaw`
    select distinct id::text as id, ${nameSelect} as name, ${logoSelect}
    from sports_data.teams
    where id is not null
      and nullif(trim(${nameSelect}), '') is not null
    order by name asc
  `;

  return z.array(TeamRow).parse(rows);
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

export async function getLimitlessMarketsForTeam(
  prisma: PrismaClient,
  teamId: string
): Promise<SportsDataMarket[]> {
  assertUuid(teamId, "teamId");
  const columns = await sportsDataColumns(prisma);
  const marketColumns = columns.get("limitless_markets") ?? new Set<string>();
  const gameColumns = columns.get("games") ?? new Set<string>();

  let rows: Array<Record<string, unknown>>;
  const canJoinGames =
    marketColumns.has("game_id") &&
    gameColumns.has("id") &&
    gameColumns.has("home_id") &&
    gameColumns.has("away_id");

  if (canJoinGames) {
    rows = (await prisma.$queryRaw`
      select lm.*, g.home_id, g.away_id
      from sports_data.limitless_markets lm
      join sports_data.games g on g.id::text = lm.game_id::text
      where g.home_id::text = ${teamId}
         or g.away_id::text = ${teamId}
    `) as Array<Record<string, unknown>>;
  } else {
    requireColumns(columns, "limitless_markets", ["home_id", "away_id"]);
    rows = (await prisma.$queryRaw`
      select lm.*
      from sports_data.limitless_markets lm
      where lm.home_id::text = ${teamId}
         or lm.away_id::text = ${teamId}
    `) as Array<Record<string, unknown>>;
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
      } satisfies SportsDataMarket;
    })
    .filter((market) => market.id.length > 0)
    .sort((a, b) => {
      const ad = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
      const bd = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return b.liquidity - a.liquidity;
    });
}
