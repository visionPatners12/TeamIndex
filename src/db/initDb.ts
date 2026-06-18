import { prisma } from "./prisma";
import { execSync } from "child_process";

function runPrismaCommand(command: string) {
  const output = execSync(command, { encoding: "utf8", stdio: "pipe" });
  if (output) process.stdout.write(output);
  return output;
}

function commandErrorOutput(err: unknown) {
  const error = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [
    String(error.stdout ?? ""),
    String(error.stderr ?? ""),
    String(error.message ?? ""),
  ].join("\n");
}

export async function initDb() {
  try {
    runPrismaCommand("npx prisma migrate deploy");
  } catch (err) {
    const output = commandErrorOutput(err);
    if (output) process.stderr.write(output);
    if (output.includes("P3005")) {
      console.error(
        [
          "Prisma P3005 detected: database schema is not empty but migration history is missing.",
          "Do not baseline automatically at runtime. Run a one-off recovery command instead.",
          "If this is a fresh app schema with Supabase objects only, run: npx prisma db push --skip-generate",
          "If app tables already exist, run: npx prisma migrate resolve --applied 20260320104741_init",
        ].join("\n")
      );
    }
    console.error("Failed to apply migrations:", err);
    throw err;
  }

  // Ensures DB connectivity
  await prisma.$connect();
  await assertRequiredTablesExist();
}

async function assertRequiredTablesExist() {
  const requiredTables = ["club_pools", "club_pool_positions"];
  const rows = await prisma.$queryRaw<Array<{ table_schema: string; table_name: string }>>`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('club_pools', 'club_pool_positions')
  `;
  const existing = new Set(rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !existing.has(table));
  const schemaName = rows[0]?.table_schema ?? "configured Prisma schema";
  if (missing.length > 0) {
    throw new Error(
      [
        `Database migration history is present, but required app tables are missing from ${schemaName}: ${missing.join(", ")}`,
        "Run a one-off schema recovery command against this database: npx prisma db push --skip-generate",
      ].join("\n")
    );
  }
}
