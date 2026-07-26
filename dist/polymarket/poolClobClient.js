"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readPoolClobCredentials = readPoolClobCredentials;
exports.createPoolClobClient = createPoolClobClient;
const clob_client_v2_1 = require("@polymarket/clob-client-v2");
const credentialCrypto_1 = require("./credentialCrypto");
const remoteSigner_1 = require("./remoteSigner");
function readPoolClobCredentials(env, account) {
    if (!account.clobApiKeyCiphertext
        || !account.clobSecretCiphertext
        || !account.clobPassphraseCiphertext) {
        throw new Error(`Polymarket CLOB credentials are not initialized for pool ${account.poolId}`);
    }
    return {
        key: (0, credentialCrypto_1.decryptPoolCredential)(env, account.poolId, "apiKey", account.clobApiKeyCiphertext),
        secret: (0, credentialCrypto_1.decryptPoolCredential)(env, account.poolId, "secret", account.clobSecretCiphertext),
        passphrase: (0, credentialCrypto_1.decryptPoolCredential)(env, account.poolId, "passphrase", account.clobPassphraseCiphertext),
    };
}
function createPoolClobClient(env, account) {
    const signer = (0, remoteSigner_1.createPolymarketSigner)(env, account.poolId, {
        ownerAddress: account.cdpOwnerAddress,
        depositWalletAddress: account.depositWalletAddress,
        vaultAddress: account.vaultAddress,
    });
    return new clob_client_v2_1.ClobClient({
        host: env.POLYMARKET_CLOB_URL,
        chain: clob_client_v2_1.Chain.POLYGON,
        signer: signer,
        creds: readPoolClobCredentials(env, account),
        signatureType: clob_client_v2_1.SignatureTypeV2.POLY_1271,
        funderAddress: account.depositWalletAddress,
        useServerTime: true,
        retryOnError: true,
        throwOnError: true,
        builderConfig: env.POLYMARKET_BUILDER_CODE
            ? { builderCode: env.POLYMARKET_BUILDER_CODE }
            : undefined,
    });
}
