import { prisma } from "./prisma";
import { execSync } from "child_process";

const baselineMigrations = [
  "20260320104741_init",
  "20260524000000_add_base_chain_deposits",
  "20260525000000_idempotent_relayers_queue",
  "20260526000000_add_chain_event_cursors",
  "20260529000000_add_market_data_json",
  "20260603000000_add_limitless_pipeline",
  "20260606000000_add_sports_data_team_id",
  "20260614000000_team_index_pryzenx_architecture",
];

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
    if (!output.includes("P3005")) {
      if (output) process.stderr.write(output);
      console.error("Failed to apply migrations:", err);
      throw err;
    }

    console.log("P3005 detected: baselining existing database...");
    for (const migration of baselineMigrations) {
      try {
        runPrismaCommand(`npx prisma migrate resolve --applied ${migration}`);
      } catch (resolveErr) {
        const resolveOutput = commandErrorOutput(resolveErr);
        if (resolveOutput) process.stderr.write(resolveOutput);
        console.warn(`Failed to mark ${migration} as applied:`, resolveErr);
      }
    }

    runPrismaCommand("npx prisma migrate deploy");
  }

  // Ensures DB connectivity
  await prisma.$connect();
}
