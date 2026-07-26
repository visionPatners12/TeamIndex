"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPoolRelayClient = createPoolRelayClient;
exports.bootstrapPoolPolymarketAccountLocal = bootstrapPoolPolymarketAccountLocal;
exports.ensurePoolDepositWalletApprovalsLocal = ensurePoolDepositWalletApprovalsLocal;
exports.bootstrapPoolPolymarketAccount = bootstrapPoolPolymarketAccount;
exports.ensurePoolDepositWalletApprovals = ensurePoolDepositWalletApprovals;
const node_crypto_1 = require("node:crypto");
const cdp_sdk_1 = require("@coinbase/cdp-sdk");
const builder_signing_sdk_1 = require("@polymarket/builder-signing-sdk");
const builder_relayer_client_1 = require("@polymarket/builder-relayer-client");
const clob_client_v2_1 = require("@polymarket/clob-client-v2");
const viem_1 = require("viem");
const prisma_1 = require("../db/prisma");
const credentialCrypto_1 = require("./credentialCrypto");
const cdpSigner_1 = require("./cdpSigner");
const egress_1 = require("./egress");
const constants_1 = require("./constants");
const polygonV2_1 = require("../onchain/polygonV2");
const money_1 = require("./money");
const constants_2 = require("./constants");
const erc20ApproveAbi = [
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
];
const erc1155ApprovalAbi = [
    {
        type: "function",
        name: "setApprovalForAll",
        stateMutability: "nonpayable",
        inputs: [
            { name: "operator", type: "address" },
            { name: "approved", type: "bool" },
        ],
        outputs: [],
    },
];
function cdpAccountName(poolId) {
    return `ti-${(0, node_crypto_1.createHash)("sha256").update(poolId).digest("hex").slice(0, 24)}`;
}
function requireCdp(env) {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET || !env.CDP_WALLET_SECRET) {
        throw new Error("CDP server-wallet credentials are required to bootstrap a pool");
    }
    return new cdp_sdk_1.CdpClient({
        apiKeyId: env.CDP_API_KEY_ID,
        apiKeySecret: env.CDP_API_KEY_SECRET,
        walletSecret: env.CDP_WALLET_SECRET,
    });
}
function builderConfig(env) {
    if (!env.POLY_BUILDER_API_KEY || !env.POLY_BUILDER_SECRET || !env.POLY_BUILDER_PASSPHRASE) {
        throw new Error("POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET and POLY_BUILDER_PASSPHRASE are required");
    }
    return new builder_signing_sdk_1.BuilderConfig({
        localBuilderCreds: {
            key: env.POLY_BUILDER_API_KEY,
            secret: env.POLY_BUILDER_SECRET,
            passphrase: env.POLY_BUILDER_PASSPHRASE,
        },
    });
}
function createPoolRelayClient(env, signer) {
    return new builder_relayer_client_1.RelayClient(env.POLYMARKET_RELAYER_URL, constants_1.POLYMARKET_CHAIN_ID, signer.createWalletClient(), builderConfig(env));
}
async function bootstrapPoolPolymarketAccountLocal(env, poolId) {
    (0, constants_2.assertPolymarketVaultDirectSupported)("Polymarket account bootstrap");
    if (env.TRADING_PROVIDER !== "polymarket")
        throw new Error("Polymarket is not the active provider");
    await (0, egress_1.assertPolymarketEgressAllowed)(env);
    const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool)
        throw new Error("Pool not found");
    const provisionalVaultAddress = pool.vaultAddress ?? env.TEAM_INDEX_V2_FACTORY_ADDRESS;
    if (!provisionalVaultAddress) {
        throw new Error("TEAM_INDEX_V2_FACTORY_ADDRESS is required before bootstrapping Polymarket");
    }
    const accountName = cdpAccountName(poolId);
    const cdpAccount = await requireCdp(env).evm.getOrCreateAccount({ name: accountName });
    const provisionalSigner = new cdpSigner_1.CdpPolymarketSigner(env, {
        ownerAddress: cdpAccount.address,
        vaultAddress: provisionalVaultAddress,
    });
    const provisionalRelay = createPoolRelayClient(env, provisionalSigner);
    const depositWalletAddress = await provisionalRelay.deriveDepositWalletAddress();
    const existing = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
    if (existing && existing.cdpOwnerAddress.toLowerCase() !== cdpAccount.address.toLowerCase()) {
        throw new Error("Existing pool account belongs to another CDP EOA; automatic key rotation is disabled");
    }
    if (existing && existing.depositWalletAddress.toLowerCase() !== depositWalletAddress.toLowerCase()) {
        throw new Error("Derived Deposit Wallet differs from the registered one; automatic rotation is disabled");
    }
    const deployed = await provisionalRelay.getDeployed(depositWalletAddress, "WALLET");
    let deployTransactionId = null;
    if (!deployed) {
        const deployment = await provisionalRelay.deployDepositWallet();
        deployTransactionId = deployment.transactionID;
        const mined = await deployment.wait();
        if (!mined || ["STATE_FAILED", "STATE_INVALID"].includes(mined.state)) {
            throw new Error("Polymarket Deposit Wallet deployment failed");
        }
    }
    let vaultAddress = pool.vaultAddress;
    let vaultDeployment = null;
    if (!vaultAddress) {
        const configuredCap = BigInt(pool.depositCap.toString().split(".")[0] || "0");
        vaultDeployment = await (0, polygonV2_1.deployPoolVaultV2)(env, {
            poolId,
            clubName: pool.clubName,
            symbol: pool.symbol,
            depositCapBaseUnits: configuredCap > 0n ? configuredCap : (0, money_1.decimalToBaseUnits)(env.POLYMARKET_PILOT_TVL_PUSD),
            depositWalletAddress,
            depositWalletOwner: cdpAccount.address,
        });
        vaultAddress = vaultDeployment.vaultAddress;
        await prisma_1.prisma.club_pools.update({ where: { id: poolId }, data: { vaultAddress } });
    }
    const signer = new cdpSigner_1.CdpPolymarketSigner(env, {
        ownerAddress: cdpAccount.address,
        depositWalletAddress,
        vaultAddress,
    });
    const unauthenticatedClient = new clob_client_v2_1.ClobClient({
        host: env.POLYMARKET_CLOB_URL,
        chain: clob_client_v2_1.Chain.POLYGON,
        signer: signer,
        signatureType: clob_client_v2_1.SignatureTypeV2.POLY_1271,
        funderAddress: depositWalletAddress,
        useServerTime: true,
        throwOnError: true,
        builderConfig: env.POLYMARKET_BUILDER_CODE
            ? { builderCode: env.POLYMARKET_BUILDER_CODE }
            : undefined,
    });
    const credentials = await unauthenticatedClient.createOrDeriveApiKey();
    const row = await prisma_1.prisma.pool_polymarket_accounts.upsert({
        where: { poolId },
        create: {
            poolId,
            cdpAccountName: accountName,
            cdpOwnerAddress: cdpAccount.address,
            depositWalletAddress,
            vaultAddress,
            clobApiKeyCiphertext: (0, credentialCrypto_1.encryptPoolCredential)(env, poolId, "apiKey", credentials.key),
            clobSecretCiphertext: (0, credentialCrypto_1.encryptPoolCredential)(env, poolId, "secret", credentials.secret),
            clobPassphraseCiphertext: (0, credentialCrypto_1.encryptPoolCredential)(env, poolId, "passphrase", credentials.passphrase),
            status: "DEPLOYED",
            rawJson: { deployTransactionId },
        },
        update: {
            vaultAddress,
            clobApiKeyCiphertext: (0, credentialCrypto_1.encryptPoolCredential)(env, poolId, "apiKey", credentials.key),
            clobSecretCiphertext: (0, credentialCrypto_1.encryptPoolCredential)(env, poolId, "secret", credentials.secret),
            clobPassphraseCiphertext: (0, credentialCrypto_1.encryptPoolCredential)(env, poolId, "passphrase", credentials.passphrase),
            status: "DEPLOYED",
            rawJson: { deployTransactionId },
        },
    });
    return {
        id: row.id,
        poolId,
        cdpAccountName: accountName,
        cdpOwnerAddress: cdpAccount.address,
        depositWalletAddress,
        vaultAddress,
        deployed: true,
        deployTransactionId,
        vaultDeployment,
        approvalsReady: row.approvalsReady,
    };
}
async function ensurePoolDepositWalletApprovalsLocal(env, poolId) {
    (0, constants_2.assertPolymarketVaultDirectSupported)("Polymarket Deposit Wallet approvals");
    const account = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
    if (!account)
        throw new Error("Pool Polymarket account is not bootstrapped");
    const signer = new cdpSigner_1.CdpPolymarketSigner(env, {
        ownerAddress: account.cdpOwnerAddress,
        depositWalletAddress: account.depositWalletAddress,
        vaultAddress: account.vaultAddress,
    });
    const relay = createPoolRelayClient(env, signer);
    const calls = [
        env.POLYMARKET_CTF_EXCHANGE_ADDRESS,
        env.POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS,
    ].flatMap((exchange) => [
        {
            target: env.POLYMARKET_PUSD_ADDRESS,
            value: "0",
            data: (0, viem_1.encodeFunctionData)({
                abi: erc20ApproveAbi,
                functionName: "approve",
                args: [exchange, viem_1.maxUint256],
            }),
        },
        {
            target: env.POLYMARKET_CTF_ADDRESS,
            value: "0",
            data: (0, viem_1.encodeFunctionData)({
                abi: erc1155ApprovalAbi,
                functionName: "setApprovalForAll",
                args: [exchange, true],
            }),
        },
    ]);
    const deadline = String(Math.floor(Date.now() / 1000) + 10 * 60);
    const transaction = await relay.executeDepositWalletBatch(calls, account.depositWalletAddress, deadline);
    const mined = await transaction.wait();
    if (!mined || ["STATE_FAILED", "STATE_INVALID"].includes(mined.state)) {
        throw new Error("Deposit Wallet approval batch failed");
    }
    await prisma_1.prisma.pool_polymarket_accounts.update({
        where: { poolId },
        data: {
            approvalsReady: true,
            status: "READY",
            rawJson: { approvalTransactionId: transaction.transactionID, approvalTransactionHash: mined.transactionHash },
        },
    });
    return {
        transactionId: transaction.transactionID,
        transactionHash: mined.transactionHash,
        depositWalletAddress: account.depositWalletAddress,
    };
}
async function callSignerService(env, path, poolId) {
    if (!env.POLYMARKET_SIGNER_URL || !env.POLYMARKET_SIGNER_TOKEN) {
        throw new Error("POLYMARKET_SIGNER_URL and POLYMARKET_SIGNER_TOKEN are required");
    }
    const response = await fetch(new URL(path, env.POLYMARKET_SIGNER_URL), {
        method: "POST",
        headers: {
            authorization: `Bearer ${env.POLYMARKET_SIGNER_TOKEN}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ poolId }),
        signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json());
    if (!response.ok)
        throw new Error(payload?.error ?? `Signer service failed (${response.status})`);
    return payload;
}
async function bootstrapPoolPolymarketAccount(env, poolId) {
    if (env.POLYMARKET_SIGNER_URL && env.PROCESS_ROLE !== "signer") {
        return callSignerService(env, "/internal/polymarket/bootstrap", poolId);
    }
    return bootstrapPoolPolymarketAccountLocal(env, poolId);
}
async function ensurePoolDepositWalletApprovals(env, poolId) {
    if (env.POLYMARKET_SIGNER_URL && env.PROCESS_ROLE !== "signer") {
        return callSignerService(env, "/internal/polymarket/approvals", poolId);
    }
    return ensurePoolDepositWalletApprovalsLocal(env, poolId);
}
