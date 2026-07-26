"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptPoolCredential = encryptPoolCredential;
exports.decryptPoolCredential = decryptPoolCredential;
const node_crypto_1 = require("node:crypto");
function encryptionKey(env) {
    const raw = env.POLYMARKET_CREDENTIALS_ENCRYPTION_KEY?.trim();
    if (!raw)
        throw new Error("POLYMARKET_CREDENTIALS_ENCRYPTION_KEY is required");
    const key = /^[a-fA-F0-9]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) {
        throw new Error("POLYMARKET_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    return key;
}
function encryptPoolCredential(env, poolId, field, plaintext) {
    const iv = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)("aes-256-gcm", encryptionKey(env), iv);
    cipher.setAAD(Buffer.from(`team-index:${poolId}:${field}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}
function decryptPoolCredential(env, poolId, field, encoded) {
    const [version, ivRaw, tagRaw, ciphertextRaw] = encoded.split(":");
    if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
        throw new Error(`Unsupported encrypted Polymarket credential format for ${field}`);
    }
    const decipher = (0, node_crypto_1.createDecipheriv)("aes-256-gcm", encryptionKey(env), Buffer.from(ivRaw, "base64"));
    decipher.setAAD(Buffer.from(`team-index:${poolId}:${field}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, "base64")),
        decipher.final(),
    ]).toString("utf8");
}
