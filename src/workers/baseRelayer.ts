import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { ethers } from "ethers";
import { ERC20 } from "../contracts/erc20";
import { getBaseDepositReceiverContract, getBaseProvider, getBaseSigner, mintBaseWrappedShares } from "../onchain/baseExecutor";
import { getVaultContract } from "../onchain/vaultExecutor";
import { compactRpcError, getRpcRateLimitCooldownUntil, isRpcRateLimitError, queryFilterInBlockChunks } from "../onchain/ethersLogChunks";
import { getLifiQuote, lifiQuoteToTransactionRequest } from "../services/lifiClient";
import {
  claimChainEventCursor,
  completeChainEventCursor,
  cursorBlockNumber,
  failChainEventCursor,
  makeCursorWorkerId
} from "./chainEventCursor";
import {
  MANUAL_RECONCILIATION_STATUS,
  decimalToBigInt,
  parseVaultSharesFromReceipt,
  relayerLockStaleBefore,
  requireSuccessfulReceipt,
  truncateRelayerError
} from "./crossChainRelayerUtils";

const BASE_CHAIN_ID = 8453;
const POLYGON_CHAIN_ID = 137;
const SHARE_DECIMAL_BRIDGE_SCALE = 10n ** 12n;
const ACTIVE_DEPOSIT_STATUSES = ["RECEIVED", "BRIDGING", "DEPOSITING", "MINTING_SHARES"] as const;

const BASE_RELEASE_STEP = "BASE_RELEASE";
const LIFI_BRIDGE_STEP = "LIFI_BRIDGE";
const POLYGON_DEPOSIT_STEP = "POLYGON_DEPOSIT";
const BASE_MINT_STEP = "BASE_MINT";

function baseDepositsModel() {
  return (prisma as any).base_chain_deposits;
}

async function waitForBalanceIncrease(params: {
  token: ethers.Contract;
  account: string;
  before: bigint;
  timeoutMs: number;
  intervalMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const current = (await params.token.balanceOf(params.account)) as bigint;
    if (current > params.before) return current - params.before;
    await new Promise((resolve) => setTimeout(resolve, params.intervalMs));
  }
  throw new Error("Timed out waiting for Polygon USDC balance increase after LI.FI bridge");
}

export function startBaseRelayer({ env, logger }: { env: Env; logger: ReturnType<any> }) {
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

  const baseProvider = getBaseProvider(env);
  const receiver = getBaseDepositReceiverContract(env, baseProvider);
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
    const workerId = makeCursorWorkerId("base-deposits");
    const cursor = await claimChainEventCursor({ ...depositCursor, startBlock }, workerId);
    if (!cursor) return;

    const lastProcessedBlock = cursorBlockNumber(cursor);
    if (currentBlock <= lastProcessedBlock) {
      await completeChainEventCursor({ key: depositCursor.key, workerId, lastProcessedBlock });
      return;
    }

    const fromBlock = lastProcessedBlock + 1;
    const toBlock = Math.min(currentBlock, lastProcessedBlock + Math.max(1, maxBlocksPerTick));

    try {
      const events = await queryFilterInBlockChunks(receiver, receiver.filters.DepositReceived(), fromBlock, toBlock, {
        chunkSizeEnv: "BASE_GETLOGS_BLOCK_CHUNK",
        logger,
        context: {
          chain: "base",
          cursorKey: depositCursor.key,
          eventName: depositCursor.eventName
        }
      });

      for (const event of events) {
        const parsed = event as ethers.EventLog;
        if (!parsed.args) continue;

        const [depositId, user, token, amount, poolIdHash] = parsed.args;
        const existing = await baseDepositsModel().findUnique({
          where: { baseDepositId: BigInt(depositId.toString()) }
        });
        if (existing) continue;

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

      await completeChainEventCursor({ key: depositCursor.key, workerId, lastProcessedBlock: toBlock });
    } catch (err) {
      const cooldownUntil = isRpcRateLimitError(err) ? getRpcRateLimitCooldownUntil() : null;
      await failChainEventCursor({ key: depositCursor.key, workerId, err, cooldownUntil });
      logger.error(
        {
          err: compactRpcError(err),
          chain: "base",
          cursorKey: depositCursor.key,
          fromBlock,
          toBlock,
          cooldownUntil: cooldownUntil?.toISOString()
        },
        "Base relayer deposit scan failed"
      );
      if (!cooldownUntil) throw err;
    }
  }

  async function markManual(depositId: string, message: string) {
    await baseDepositsModel().update({
      where: { id: depositId },
      data: {
        status: MANUAL_RECONCILIATION_STATUS,
        lastError: message.slice(0, 500),
        processingLockedAt: null,
        processingLockedBy: null
      }
    });
  }

  async function failDeposit(depositId: string, err: unknown) {
    await baseDepositsModel().update({
      where: { id: depositId },
      data: {
        status: "FAILED",
        lastError: truncateRelayerError(err),
        processingLockedAt: null,
        processingLockedBy: null
      }
    });
  }

  async function claimDeposit(deposit: any, workerId: string) {
    const result = await baseDepositsModel().updateMany({
      where: {
        id: deposit.id,
        status: deposit.status,
        OR: [
          { processingLockedAt: null },
          { processingLockedAt: { lt: relayerLockStaleBefore("BASE") } }
        ]
      },
      data: {
        processingLockedAt: new Date(),
        processingLockedBy: workerId,
        attempts: { increment: 1 },
        lastError: null
      }
    });
    if (result.count !== 1) return null;
    return baseDepositsModel().findUnique({ where: { id: deposit.id } });
  }

  async function resolvePool(deposit: any) {
    if (deposit.clubPoolId) {
      const existing = await prisma.club_pools.findUnique({ where: { id: deposit.clubPoolId } });
      if (existing?.status === "ACTIVE") return existing;
    }

    const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
    const targetPool = pools.find((p) => ethers.keccak256(ethers.toUtf8Bytes(p.clubName)) === deposit.poolIdHash);
    if (!targetPool) throw new Error(`No active pool found for poolId hash ${deposit.poolIdHash}`);

    await baseDepositsModel().update({
      where: { id: deposit.id },
      data: { clubPoolId: targetPool.id }
    });
    return targetPool;
  }

  async function getPolygonVaultContext(targetPool: { clubName: string; vaultAddress: string | null }, polygonProvider: ethers.JsonRpcProvider, polygonSigner: ethers.Wallet) {
    const vault = await getVaultContract(env, polygonProvider as any, {
      clubName: targetPool.clubName,
      vaultAddress: targetPool.vaultAddress ?? undefined
    });
    const vaultAddress: string = (vault as any).target ?? (vault as any).address;
    const polygonAssetAddress: string = await (vault as any).asset();
    const polygonUsdc = new ethers.Contract(polygonAssetAddress, ERC20.abi, polygonSigner);
    return { vault, vaultAddress, polygonAssetAddress, polygonUsdc };
  }

  async function processBaseDeposit(deposit: any) {
    let current = deposit;
    const baseSigner = getBaseSigner(env);
    const polygonProvider = new ethers.JsonRpcProvider(env.RPC_URL, undefined, { batchMaxCount: 1 });
    const polygonSigner = new ethers.Wallet(env.EXECUTOR_PRIVATE_KEY!, polygonProvider);
    const baseSignerAddress = await baseSigner.getAddress();
    const polygonSignerAddress = await polygonSigner.getAddress();

    if (current.sourceToken.toLowerCase() !== env.BASE_USDC_ADDRESS!.toLowerCase()) {
      throw new Error(`Unsupported Base source token ${current.sourceToken}`);
    }

    const targetPool = await resolvePool(current);

    if (current.status === "RECEIVED") {
      if (!current.releaseTxHash) {
        await baseDepositsModel().update({
          where: { id: current.id },
          data: { status: "BRIDGING", processingStep: BASE_RELEASE_STEP, lastError: null }
        });

        const receiverWithSigner = getBaseDepositReceiverContract(env, baseSigner);
        const releaseTx = await (receiverWithSigner as any).releaseDeposit(current.baseDepositId, baseSignerAddress);
        await baseDepositsModel().update({
          where: { id: current.id },
          data: { releaseTxHash: releaseTx.hash }
        });
        await requireSuccessfulReceipt(baseProvider, releaseTx.hash, "Base release");
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

      await requireSuccessfulReceipt(baseProvider, current.releaseTxHash, "Base release");
      const { vault, vaultAddress, polygonAssetAddress, polygonUsdc } = await getPolygonVaultContext(targetPool, polygonProvider, polygonSigner);

      if (!current.lifiBridgeTxHash) {
        if (current.processingStep === LIFI_BRIDGE_STEP || current.polygonBalanceBeforeBridge) {
          await markManual(current.id, "LI.FI bridge may have been attempted but lifiBridgeTxHash is missing");
          return;
        }

        const polygonBalanceBefore = (await polygonUsdc.balanceOf(polygonSignerAddress)) as bigint;
        await baseDepositsModel().update({
          where: { id: current.id },
          data: {
            processingStep: LIFI_BRIDGE_STEP,
            polygonBalanceBeforeBridge: polygonBalanceBefore.toString()
          }
        });

        const baseUsdc = new ethers.Contract(env.BASE_USDC_ADDRESS!, ERC20.abi, baseSigner);
        const quote = await getLifiQuote(env, {
          fromChain: BASE_CHAIN_ID,
          toChain: POLYGON_CHAIN_ID,
          fromToken: env.BASE_USDC_ADDRESS!,
          toToken: polygonAssetAddress,
          fromAmount: current.sourceAmount.toString(),
          fromAddress: baseSignerAddress,
          toAddress: polygonSignerAddress
        });

        const approveTx = await baseUsdc.approve(quote.estimate!.approvalAddress!, BigInt(current.sourceAmount.toString()));
        await approveTx.wait();

        const lifiTx = await baseSigner.sendTransaction(lifiQuoteToTransactionRequest(quote));
        await baseDepositsModel().update({
          where: { id: current.id },
          data: { lifiBridgeTxHash: lifiTx.hash }
        });
        await requireSuccessfulReceipt(baseProvider, lifiTx.hash, "LI.FI bridge");

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
          before: decimalToBigInt(current.polygonBalanceBeforeBridge),
          timeoutMs: Number(process.env.BASE_LIFI_BRIDGE_TIMEOUT_MS || 900_000),
          intervalMs: Number(process.env.BASE_LIFI_BRIDGE_POLL_MS || 15_000)
        });

        current = await baseDepositsModel().update({
          where: { id: current.id },
          data: { status: "DEPOSITING", usdcAmount: usdcReceived.toString(), processingStep: null }
        });
      } else {
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
      const usdcReceived = decimalToBigInt(current.usdcAmount);

      if (!current.polygonDepositTxHash) {
        if (current.processingStep === POLYGON_DEPOSIT_STEP) {
          await markManual(current.id, "Polygon vault deposit may have been attempted but polygonDepositTxHash is missing");
          return;
        }

        const approveVaultTx = await polygonUsdc.approve(vaultAddress, usdcReceived);
        await approveVaultTx.wait();

        const vaultWithSigner = new ethers.Contract(
          vaultAddress,
          [
            "function deposit(uint256,address) external returns (uint256)",
            "function balanceOf(address) external view returns (uint256)",
            "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
          ],
          polygonSigner
        );
        const shareBalanceBefore = (await vaultWithSigner.balanceOf(polygonSignerAddress)) as bigint;

        await baseDepositsModel().update({
          where: { id: current.id },
          data: { processingStep: POLYGON_DEPOSIT_STEP }
        });

        const depositTx = await vaultWithSigner.deposit(usdcReceived, polygonSignerAddress);
        await baseDepositsModel().update({
          where: { id: current.id },
          data: { polygonDepositTxHash: depositTx.hash }
        });
        const depositReceipt = await requireSuccessfulReceipt(polygonProvider, depositTx.hash, "Polygon vault deposit");
        const shareBalanceAfter = (await vaultWithSigner.balanceOf(polygonSignerAddress)) as bigint;
        const sharesMinted = parseVaultSharesFromReceipt(depositReceipt) ?? (shareBalanceAfter - shareBalanceBefore);

        current = await baseDepositsModel().update({
          where: { id: current.id },
          data: {
            status: "MINTING_SHARES",
            sharesMinted: sharesMinted.toString(),
            processingStep: null
          }
        });
      } else if (!current.sharesMinted) {
        const depositReceipt = await requireSuccessfulReceipt(polygonProvider, current.polygonDepositTxHash, "Polygon vault deposit");
        const sharesMinted = parseVaultSharesFromReceipt(depositReceipt);
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
      } else {
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
        await requireSuccessfulReceipt(baseProvider, current.baseMintTxHash, "Base wrapped share mint");
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

      const wrappedShareAmount = decimalToBigInt(current.sharesMinted) * SHARE_DECIMAL_BRIDGE_SCALE;
      const depositIdHex = ethers.zeroPadValue(ethers.toBeHex(current.baseDepositId), 32);

      await baseDepositsModel().update({
        where: { id: current.id },
        data: { processingStep: BASE_MINT_STEP }
      });

      const mintTx = await mintBaseWrappedShares(env, current.userAddress, wrappedShareAmount, depositIdHex);
      await baseDepositsModel().update({
        where: { id: current.id },
        data: { baseMintTxHash: mintTx.hash }
      });
      await requireSuccessfulReceipt(baseProvider, mintTx.hash, "Base wrapped share mint");

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
          { processingLockedAt: { lt: relayerLockStaleBefore("BASE") } }
        ]
      },
      take: 5,
      orderBy: { createdAt: "asc" }
    });

    const workerId = `base-relayer:${process.pid}:${Date.now()}`;
    for (const deposit of pending) {
      const claimed = await claimDeposit(deposit, workerId);
      if (!claimed) continue;

      try {
        await processBaseDeposit(claimed);
      } catch (err: any) {
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
    } finally {
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
