"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDb = initDb;
const prisma_1 = require("./prisma");
const child_process_1 = require("child_process");
async function initDb() {
    // Apply pending migrations on startup
    try {
        (0, child_process_1.execSync)("npx prisma migrate deploy", { stdio: "inherit" });
    }
    catch (err) {
        console.error("Failed to apply migrations:", err);
        throw err;
    }
    // Ensures DB connectivity
    await prisma_1.prisma.$connect();
}
