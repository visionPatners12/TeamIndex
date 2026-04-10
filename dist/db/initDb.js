"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDb = initDb;
const prisma_1 = require("./prisma");
async function initDb() {
    // Ensures DB connectivity early.
    await prisma_1.prisma.$connect();
}
