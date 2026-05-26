"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBaseRelayer = startBaseRelayer;
const prisma_1 = require("../db/prisma");
const ethers_1 = require("ethers");
const erc20_1 = require("../contracts/erc20");
const baseExecutor_1 = require("../onchain/baseExecutor");
const vaultExecutor_1 = require("../onchain/vaultExecutor");
const ethersLogChunks_1 = require("../onchain/ethersLogChunks");
const lifiClient_1 = require("../services/lifiClient");
const chainEventCursor_1 = require("./chainEventCursor");
const crossChainRelayerUtils_1 = require("./crossChainRelayerUtils");
const BASE_CHAIN_ID = 8453;
const POLYGON_CHAIN_ID = 137;
const SHARE_DECIMAL_BRIDGE_SCALE = 10n ** 12n;
const ACTIVE_DEPOSIT_STATUSES = ["RECEIVED", "BRIDGING", "DEPOSITING", "MINTING_SHARES"];
const BASE_RELEASE_STEP = "BASE_RELEASE";
const LIFI_BRIDGE_STEP = "LIFI_BRIDGE";
const POLYGON_DEPOSIT_STEP = "POLYGON_DEPOSIT";
const BASE_MINT_STEP = "BASE_MINT";
function baseDepositsModel() {
    return prisma_1.prisma.base_chain_deposits;
}
async function waitForBalanceIncrease(params) {
    const deadline = Date.now() + params.timeoutMs;
    while (Date.now() < deadline) {
        const current = (await params.token.balanceOf(params.account));
        if (current > params.before)
            return current - params.before;
        await new Promise((resolve) => setTimeout(resolve, params.intervalMs));
    }
    throw new Error("Timed out waiting for Polygon USDC balance increase after LI.FI bridge");
}
function startBaseRelayer({ env, logger }) {
    const intervalMs = Number(process.env.BASE_RELAYER_INTERVAL_MS || 30_000);
    const maxBlocksRaw = Number(process.env.BASE_RELAYER_MAX_BLOCKS_PER_TICK || 100);
    const maxBlocksPerTick = Number.isFinite(maxBlocksRaw) && maxBlocksRaw > 0 ? Math.floor(maxBlocksRaw) : 100;
    if (!env.BASE_RPC_URL || !env.BASE_DEPOSIT_RECEIVER_ADDRESS || !env.BASE_WRAPPED_SHARE_ADDRESS || !env.BASE_USDC_ADDRESS) {
        logger.warn("Base relayer skipped: missing BASE_RPC_URL / BASE_DEPOSIT_RECEIVER_ADDRESS / BASE_WRAPPED_SHARE_ADDRESS / BASE_USDC_ADDRESS");
        return;
    }
    if (!env.BASE_EXECUTOR_PRIVATE_KEY) {
        logger.warn("Base relayer skipped: BASE_EXECUTOR_PRIVATE_KEY not set");
        return;
    }
    if (!env.RPC_URL || !env.EXECUTOR_PRIVATE_KEY) {
        logger.warn("Base relayer skipped: Polygon RPC_URL / EXECUTOR_PRIVATE_KEY required for vault deposits");
        return;
    }
    logger.info({ intervalMs }, "Base relayer started");
    const baseProvider = (0, baseExecutor_1.getBaseProvider)(env);
    const receiver = (0, baseExecutor_1.getBaseDepositReceiverContract)(env, baseProvider);
    const depositCursor = {
        key: `base:${env.BASE_DEPOSIT_RECEIVER_ADDRESS.toLowerCase()}:DepositReceived`,
        chain: "base",
        contractAddress: env.BASE_DEPOSIT_RECEIVER_ADDRESS,
        eventName: "DepositReceived"
    };
    let isTicking = false;
    async function pollNewDeposits() {
        const currentBlock = await baseProvider.getBlockNumber();
        const startBlock = Math.max(0, currentBlock - Number(process.env.BASE_RELAYER_START_BLOCK_LOOKBACK || 1000));
        const workerId = (0, chainEventCursor_1.makeCursorWorkerId)("base-deposits");
        const cursor = await (0, chainEventCursor_1.claimChainEventCursor)({ ...depositCursor, startBlock }, workerId);
        if (!cursor)
            return;
        const lastProcessedBlock = (0, chainEventCursor_1.cursorBlockNumber)(cursor);
        if (currentBlock <= lastProcessedBlock) {
            await (0, chainEventCursor_1.completeChainEventCursor)({ key: depositCursor.key, workerId, lastProcessedBlock });
            return;
        }
        const fromBlock = lastProcessedBlock + 1;
        const toBlock = Math.min(currentBlock, lastProcessedBlock + Math.max(1, maxBlocksPerTick));
        try {
            const events = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(receiver, receiver.filters.DepositReceived(), fromBlock, toBlock, {
                chunkSizeEnv: "BASE_GETLOGS_BLOCK_CHUNK",
                logger,
                context: {
                    chain: "base",
                    cursorKey: depositCursor.key,
                    eventName: depositCursor.eventName
                }
            });
            for (const event of events) {
                const parsed = event;
                if (!parsed.args)
                    continue;
                const [depositId, user, token, amount, poolIdHash] = parsed.args;
                const existing = await baseDepositsModel().findUnique({
                    where: { baseDepositId: BigInt(depositId.toString()) }
                });
                if (existing)
                    continue;
                await baseDepositsModel().create({
                    data: {
                        poolIdHash: poolIdHash.toString(),
                        userAddress: user,
                        sourceToken: token,
                        sourceAmount: amount.toString(),
                        baseDepositId: BigInt(depositId.toString()),
                        baseTxHash: parsed.transactionHash,
                        status: "RECEIVED"
                    }
                });
                logger.info({ depositId: depositId.toString(), user, amount: amount.toString() }, "New Base USDC deposit received");
            }
            await (0, chainEventCursor_1.completeChainEventCursor)({ key: depositCursor.key, workerId, lastProcessedBlock: toBlock });
        }
        catch (err) {
            const cooldownUntil = (0, ethersLogChunks_1.isRpcRateLimitError)(err) ? (0, ethersLogChunks_1.getRpcRateLimitCooldownUntil)() : null;
            await (0, chainEventCursor_1.failChainEventCursor)({ key: depositCursor.key, workerId, err, cooldownUntil });
            logger.error({
                err: (0, ethersLogChunks_1.compactRpcError)(err),
                chain: "base",
                cursorKey: depositCursor.key,
                fromBlock,
                toBlock,
                cooldownUntil: cooldownUntil?.toISOString()
            }, "Base relayer deposit scan failed");
            if (!cooldownUntil)
                throw err;
        }
    }
    async function markManual(depositId, message) {
        await baseDepositsModel().update({
            where: { id: depositId },
            data: {
                status: crossChainRelayerUtils_1.MANUAL_RECONCILIATION_STATUS,
                lastError: message.slice(0, 500),
                processingLockedAt: null,
                processingLockedBy: null
            }
        });
    }
    async function failDeposit(depositId, err) {
        await baseDepositsModel().update({
            where: { id: depositId },
            data: {
                status: "FAILED",
                lastError: (0, crossChainRelayerUtils_1.truncateRelayerError)(err),
                processingLockedAt: null,
                processingLockedBy: null
            }
        });
    }
    async function claimDeposit(deposit, workerId) {
        const result = await baseDepositsModel().updateMany({
            where: {
                id: deposit.id,
                status: deposit.status,
                OR: [
                    { processingLockedAt: null },
                    { processingLockedAt: { lt: (0, crossChainRelayerUtils_1.relayerLockStaleBefore)("BASE") } }
                ]
            },
            data: {
                processingLockedAt: new Date(),
                processingLockedBy: workerId,
                attempts: { increment: 1 },
                lastError: null
            }
        });
        if (result.count !== 1)
            return null;
        return baseDepositsModel().findUnique({ where: { id: deposit.id } });
    }
    async function resolvePool(deposit) {
        if (deposit.clubPoolId) {
            const existing = await prisma_1.prisma.club_pools.findUnique({ where: { id: deposit.clubPoolId } });
            if (existing?.status === "ACTIVE")
                return existing;
        }
        const pools = await prisma_1.prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
        const targetPool = pools.find((p) => ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(p.clubName)) === deposit.poolIdHash);
        if (!targetPool)
            throw new Error(`No active pool found for poolId hash ${deposit.poolIdHash}`);
        await baseDepositsModel().update({
            where: { id: deposit.id },
            data: { clubPoolId: targetPool.id }
        });
        return targetPool;
    }
    async function getPolygonVaultContext(targetPool, polygonProvider, polygonSigner) {
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, polygonProvider, {
            clubName: targetPool.clubName,
            vaultAddress: targetPool.vaultAddress ?? undefined
        });
        const vaultAddress = vault.target ?? vault.address;
        const polygonAssetAddress = await vault.asset();
        const polygonUsdc = new ethers_1.ethers.Contract(polygonAssetAddress, erc20_1.ERC20.abi, polygonSigner);
        return { vault, vaultAddress, polygonAssetAddress, polygonUsdc };
    }
    async function processBaseDeposit(deposit) {
        let current = deposit;
        const baseSigner = (0, baseExecutor_1.getBaseSigner)(env);
        const polygonProvider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL, undefined, { batchMaxCount: 1 });
        const polygonSigner = new ethers_1.ethers.Wallet(env.EXECUTOR_PRIVATE_KEY, polygonProvider);
        const baseSignerAddress = await baseSigner.getAddress();
        const polygonSignerAddress = await polygonSigner.getAddress();
        if (current.sourceToken.toLowerCase() !== env.BASE_USDC_ADDRESS.toLowerCase()) {
            throw new Error(`Unsupported Base source token ${current.sourceToken}`);
        }
        const targetPool = await resolvePool(current);
        if (current.status === "RECEIVED") {
            if (!current.releaseTxHash) {
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { status: "BRIDGING", processingStep: BASE_RELEASE_STEP, lastError: null }
                });
                const receiverWithSigner = (0, baseExecutor_1.getBaseDepositReceiverContract)(env, baseSigner);
                const releaseTx = await receiverWithSigner.releaseDeposit(current.baseDepositId, baseSignerAddress);
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { releaseTxHash: releaseTx.hash }
                });
                await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(baseProvider, releaseTx.hash, "Base release");
            }
            current = await baseDepositsModel().update({
                where: { id: current.id },
                data: { status: "BRIDGING", processingStep: null }
            });
        }
        if (current.status === "BRIDGING") {
            if (!current.releaseTxHash) {
                await markManual(current.id, "Base release may have been attempted but releaseTxHash is missing");
                return;
            }
            await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(baseProvider, current.releaseTxHash, "Base release");
            const { vault, vaultAddress, polygonAssetAddress, polygonUsdc } = await getPolygonVaultContext(targetPool, polygonProvider, polygonSigner);
            if (!current.lifiBridgeTxHash) {
                if (current.processingStep === LIFI_BRIDGE_STEP || current.polygonBalanceBeforeBridge) {
                    await markManual(current.id, "LI.FI bridge may have been attempted but lifiBridgeTxHash is missing");
                    return;
                }
                const polygonBalanceBefore = (await polygonUsdc.balanceOf(polygonSignerAddress));
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: {
                        processingStep: LIFI_BRIDGE_STEP,
                        polygonBalanceBeforeBridge: polygonBalanceBefore.toString()
                    }
                });
                const baseUsdc = new ethers_1.ethers.Contract(env.BASE_USDC_ADDRESS, erc20_1.ERC20.abi, baseSigner);
                const quote = await (0, lifiClient_1.getLifiQuote)(env, {
                    fromChain: BASE_CHAIN_ID,
                    toChain: POLYGON_CHAIN_ID,
                    fromToken: env.BASE_USDC_ADDRESS,
                    toToken: polygonAssetAddress,
                    fromAmount: current.sourceAmount.toString(),
                    fromAddress: baseSignerAddress,
                    toAddress: polygonSignerAddress
                });
                const approveTx = await baseUsdc.approve(quote.estimate.approvalAddress, BigInt(current.sourceAmount.toString()));
                await approveTx.wait();
                const lifiTx = await baseSigner.sendTransaction((0, lifiClient_1.lifiQuoteToTransactionRequest)(quote));
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { lifiBridgeTxHash: lifiTx.hash }
                });
                await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(baseProvider, lifiTx.hash, "LI.FI bridge");
                current = await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { processingStep: null }
                });
            }
            if (!current.usdcAmount) {
                if (!current.polygonBalanceBeforeBridge) {
                    await markManual(current.id, "LI.FI bridge hash exists but polygonBalanceBeforeBridge is missing");
                    return;
                }
                const usdcReceived = await waitForBalanceIncrease({
                    token: polygonUsdc,
                    account: polygonSignerAddress,
                    before: (0, crossChainRelayerUtils_1.decimalToBigInt)(current.polygonBalanceBeforeBridge),
                    timeoutMs: Number(process.env.BASE_LIFI_BRIDGE_TIMEOUT_MS || 900_000),
                    intervalMs: Number(process.env.BASE_LIFI_BRIDGE_POLL_MS || 15_000)
                });
                current = await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { status: "DEPOSITING", usdcAmount: usdcReceived.toString(), processingStep: null }
                });
            }
            else {
                current = await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { status: "DEPOSITING", processingStep: null }
                });
            }
            void vault;
            void vaultAddress;
        }
        if (current.status === "DEPOSITING") {
            if (!current.usdcAmount) {
                await markManual(current.id, "Base deposit is DEPOSITING but usdcAmount is missing");
                return;
            }
            const { vaultAddress, polygonUsdc } = await getPolygonVaultContext(targetPool, polygonProvider, polygonSigner);
            const usdcReceived = (0, crossChainRelayerUtils_1.decimalToBigInt)(current.usdcAmount);
            if (!current.polygonDepositTxHash) {
                if (current.processingStep === POLYGON_DEPOSIT_STEP) {
                    await markManual(current.id, "Polygon vault deposit may have been attempted but polygonDepositTxHash is missing");
                    return;
                }
                const approveVaultTx = await polygonUsdc.approve(vaultAddress, usdcReceived);
                await approveVaultTx.wait();
                const vaultWithSigner = new ethers_1.ethers.Contract(vaultAddress, [
                    "function deposit(uint256,address) external returns (uint256)",
                    "function balanceOf(address) external view returns (uint256)",
                    "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
                ], polygonSigner);
                const shareBalanceBefore = (await vaultWithSigner.balanceOf(polygonSignerAddress));
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { processingStep: POLYGON_DEPOSIT_STEP }
                });
                const depositTx = await vaultWithSigner.deposit(usdcReceived, polygonSignerAddress);
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { polygonDepositTxHash: depositTx.hash }
                });
                const depositReceipt = await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(polygonProvider, depositTx.hash, "Polygon vault deposit");
                const shareBalanceAfter = (await vaultWithSigner.balanceOf(polygonSignerAddress));
                const sharesMinted = (0, crossChainRelayerUtils_1.parseVaultSharesFromReceipt)(depositReceipt) ?? (shareBalanceAfter - shareBalanceBefore);
                current = await baseDepositsModel().update({
                    where: { id: current.id },
                    data: {
                        status: "MINTING_SHARES",
                        sharesMinted: sharesMinted.toString(),
                        processingStep: null
                    }
                });
            }
            else if (!current.sharesMinted) {
                const depositReceipt = await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(polygonProvider, current.polygonDepositTxHash, "Polygon vault deposit");
                const sharesMinted = (0, crossChainRelayerUtils_1.parseVaultSharesFromReceipt)(depositReceipt);
                if (!sharesMinted || sharesMinted <= 0n) {
                    await markManual(current.id, "Polygon vault deposit hash exists but minted shares could not be recovered");
                    return;
                }
                current = await baseDepositsModel().update({
                    where: { id: current.id },
                    data: {
                        status: "MINTING_SHARES",
                        sharesMinted: sharesMinted.toString(),
                        processingStep: null
                    }
                });
            }
            else {
                current = await baseDepositsModel().update({
                    where: { id: current.id },
                    data: { status: "MINTING_SHARES", processingStep: null }
                });
            }
        }
        if (current.status === "MINTING_SHARES") {
            if (!current.sharesMinted) {
                await markManual(current.id, "Base deposit is MINTING_SHARES but sharesMinted is missing");
                return;
            }
            if (current.baseMintTxHash) {
                await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(baseProvider, current.baseMintTxHash, "Base wrapped share mint");
                await baseDepositsModel().update({
                    where: { id: current.id },
                    data: {
                        status: "COMPLETED",
                        processingStep: null,
                        processingLockedAt: null,
                        processingLockedBy: null,
                        lastError: null
                    }
                });
                return;
            }
            if (current.processingStep === BASE_MINT_STEP) {
                await markManual(current.id, "Base wrapped share mint may have been attempted but baseMintTxHash is missing");
                return;
            }
            const wrappedShareAmount = (0, crossChainRelayerUtils_1.decimalToBigInt)(current.sharesMinted) * SHARE_DECIMAL_BRIDGE_SCALE;
            const depositIdHex = ethers_1.ethers.zeroPadValue(ethers_1.ethers.toBeHex(current.baseDepositId), 32);
            await baseDepositsModel().update({
                where: { id: current.id },
                data: { processingStep: BASE_MINT_STEP }
            });
            const mintTx = await (0, baseExecutor_1.mintBaseWrappedShares)(env, current.userAddress, wrappedShareAmount, depositIdHex);
            await baseDepositsModel().update({
                where: { id: current.id },
                data: { baseMintTxHash: mintTx.hash }
            });
            await (0, crossChainRelayerUtils_1.requireSuccessfulReceipt)(baseProvider, mintTx.hash, "Base wrapped share mint");
            await baseDepositsModel().update({
                where: { id: current.id },
                data: {
                    status: "COMPLETED",
                    processingStep: null,
                    processingLockedAt: null,
                    processingLockedBy: null,
                    lastError: null
                }
            });
            logger.info({
                baseDepositId: current.baseDepositId.toString(),
                user: current.userAddress,
                usdcReceived: current.usdcAmount?.toString(),
                vaultShares: current.sharesMinted?.toString(),
                wrappedSharesMinted: wrappedShareAmount.toString()
            }, "Base deposit completed");
        }
    }
    async function processOpenDeposits() {
        const pending = await baseDepositsModel().findMany({
            where: {
                status: { in: ACTIVE_DEPOSIT_STATUSES },
                OR: [
                    { processingLockedAt: null },
                    { processingLockedAt: { lt: (0, crossChainRelayerUtils_1.relayerLockStaleBefore)("BASE") } }
                ]
            },
            take: 5,
            orderBy: { createdAt: "asc" }
        });
        const workerId = `base-relayer:${process.pid}:${Date.now()}`;
        for (const deposit of pending) {
            const claimed = await claimDeposit(deposit, workerId);
            if (!claimed)
                continue;
            try {
                await processBaseDeposit(claimed);
            }
            catch (err) {
                logger.error({ err, depositId: claimed.id }, "Base deposit processing failed");
                await failDeposit(claimed.id, err);
            }
        }
    }
    async function tick() {
        if (isTicking) {
            logger.warn("Base relayer tick skipped: previous tick still running");
            return;
        }
        isTicking = true;
        try {
            await pollNewDeposits();
            await processOpenDeposits();
        }
        finally {
            isTicking = false;
        }
    }
    tick()
        .then(() => logger.info("Initial Base relayer tick done"))
        .catch((err) => logger.error({ err }, "Initial Base relayer tick failed"));
    setInterval(() => {
        tick().catch((err) => logger.error({ err }, "Base relayer tick failed"));
    }, intervalMs);
}
