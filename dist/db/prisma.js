"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
// In dev, hot-reload can create multiple clients; this pattern prevents leaks.
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma ??
    new client_1.PrismaClient({
        log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
    });
if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = exports.prisma;
}
