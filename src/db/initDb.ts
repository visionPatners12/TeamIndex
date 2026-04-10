import { prisma } from "./prisma";

export async function initDb() {
  // Ensures DB connectivity early.
  await prisma.$connect();
}

