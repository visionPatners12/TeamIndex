import { prisma } from "./prisma";
import { execSync } from "child_process";

export async function initDb() {
  // Apply pending migrations on startup
  try {
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
  } catch (err) {
    console.error("Failed to apply migrations:", err);
    throw err;
  }

  // Ensures DB connectivity
  await prisma.$connect();
}

