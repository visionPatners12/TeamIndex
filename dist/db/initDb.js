"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDb = initDb;
const prisma_1 = require("./prisma");
const child_process_1 = require("child_process");
function runPrismaCommand(command) {
    const output = (0, child_process_1.execSync)(command, { encoding: "utf8", stdio: "pipe" });
    if (output)
        process.stdout.write(output);
    return output;
}
function commandErrorOutput(err) {
    const error = err;
    return [
        String(error.stdout ?? ""),
        String(error.stderr ?? ""),
        String(error.message ?? ""),
    ].join("\n");
}
async function initDb() {
    try {
        runPrismaCommand("npx prisma migrate deploy");
    }
    catch (err) {
        const output = commandErrorOutput(err);
        if (output)
            process.stderr.write(output);
        if (output.includes("P3005")) {
            console.error([
                "Prisma P3005 detected: database schema is not empty but migration history is missing.",
                "Do not baseline automatically at runtime. Run a one-off recovery command instead.",
                "If this is a fresh app schema with Supabase objects only, run: npx prisma db push --skip-generate",
                "If app tables already exist, run: npx prisma migrate resolve --applied 20260320104741_init",
            ].join("\n"));
        }
        console.error("Failed to apply migrations:", err);
        throw err;
    }
    // Ensures DB connectivity
    await prisma_1.prisma.$connect();
    await assertRequiredTablesExist();
}
async function assertRequiredTablesExist() {
    const requiredTables = ["club_pools", "club_pool_positions"];
    const rows = await prisma_1.prisma.$queryRaw `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('club_pools', 'club_pool_positions')
  `;
    const existing = new Set(rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !existing.has(table));
    if (missing.length > 0) {
        throw new Error([
            `Database migration history is present, but required app tables are missing: ${missing.join(", ")}`,
            "Run a one-off schema recovery command against this database: npx prisma db push --skip-generate",
        ].join("\n"));
    }
}
