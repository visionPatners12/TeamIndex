"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeError = serializeError;
exports.createLogger = createLogger;
const pino_1 = __importDefault(require("pino"));
function serializeError(err) {
    if (err instanceof Error) {
        return {
            ...Object.fromEntries(Object.entries(err)),
            name: err.name,
            message: err.message,
            stack: err.stack,
            cause: err.cause ? serializeError(err.cause) : undefined,
        };
    }
    if (err && typeof err === "object")
        return err;
    return { message: String(err) };
}
function createLogger() {
    return (0, pino_1.default)({ level: process.env.LOG_LEVEL || "info" });
}
