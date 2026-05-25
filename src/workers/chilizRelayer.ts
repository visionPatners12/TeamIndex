import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { ethers } from "ethers";
import { getDepositReceiverContract, mintWrappedShares, getChilizProvider } from "../onchain/chilizExecutor";
import { getVaultContract } from "../onchain/vaultExecutor";
import { queryFilterInBlockChunks } from "../onchain/ethersLogChunks";
import {
  MANUAL_RECONCILIATION_STATUS,
  decimalToBigInt,
  parseVaultSharesFromReceipt,
  relayerLockStaleBefore,
  requireSuccessfulReceipt,
  truncateRelayerError
} from "./crossChainRelayerUtils";

const SHARE_DECIMAL_BRIDGE_SCALE = 10n ** 12n;
const ACTIVE_DEPOSIT_STATUSES = ["RECEIVED", "DEPOSITING", "MINTING_SHARES"] as const;
const POLYGON_DEPOSIT_STEP = "POLYGON_DEPOSIT";
const CHILIZ_MINT_STEP = "CHILIZ_MINT";

export function startChilizRelayer({ env, logger }: { env: Env; logger: ReturnType<any> }) {
  const intervalMs = Number(process.env.CHILIZ_RELAYER_INTERVAL_MS || 30_000);

  if (!env.CHILIZ_RPC_URL || !env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS || !env.CHILIZ_WRAPPED_SHARE_ADDRESS) {
    logger.warn("Chiliz relayer skipped: missing CHILIZ_RPC_URL / CHILIZ_DEPOSIT_RECEIVER_ADDRESS / CHILIZ_WRAPPED_SHARE_ADDRESS");
    return;
  }
  if (!env.CHILIZ_EXECUTOR_PRIVATE_KEY) {
    logger.warn("Chiliz relayer skipped: CHILIZ_EXECUTOR_PRIVATE_KEY not set");
    return;
  }
  if (!env.RPC_URL || !env.EXECUTOR_PRIVATE_KEY) {
    logger.warn("Chiliz relayer skipped: Polygon RPC_URL / EXECUTOR_PRIVATE_KEY required for vault deposits");
    return;
  }

  logger.info({ intervalMs }, "Chiliz relayer started");

  const chilizProvider = getChilizProvider(env);
  const receiver = getDepositReceiverContract(env, chilizProvider);
  let lastProcessedBlock = 0;

  async function pollNewDeposits() {
    const currentBlock = await chilizProvider.getBlockNumber();
    if (lastProcessedBlock === 0) {
      lastProcessedBlock = Math.max(0, currentBlock - 1000);
    }

    if (currentBlock <= lastProcessedBlock) return;

    const fromBlock = lastProcessedBlock + 1;
    const toBlock = currentBlock;

    const filter = receiver.filters.DepositReceived();
    const events = await queryFilterInBlockChunks(receiver, filter, fromBlock, toBlock);

    for (const event of events) {
      const parsed = event as ethers.EventLog;
      if (!parsed.args) continue;

      const [depositId, user, token, amount, poolIdHash] = parsed.args;

      const existing = await prisma.cross_chain_deposits.findUnique({
        where: { chilizDepositId: BigInt(depositId.toString()) }
      });
      if (existing) continue;

      await prisma.cross_chain_deposits.create({
        data: {
          poolId: poolIdHash.toString(),
          userAddress: user,
          sourceToken: token,
          sourceAmount: amount.toString(),
          chilizDepositId: BigInt(depositId.toString()),
          chilizTxHash: parsed.transactionHash,
          status: "RECEIVED"
        }
      });

      logger.info({ depositId: depositId.toString(), user, token, amount: amount.toString() }, "New Chiliz deposit received");
    }

    lastProcessedBlock = toBlock;
  }

  async function markManual(depositId: string, message: string) {
    await prisma.cross_chain_deposits.update({
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
    await prisma.cross_chain_deposits.update({
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
    const result = await prisma.cross_chain_deposits.updateMany({
      where: {
        id: deposit.id,
        status: deposit.status,
        OR: [
          { processingLockedAt: null },
          { processingLockedAt: { lt: relayerLockStaleBefore("CHILIZ") } }
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
    return prisma.cross_chain_deposits.findUnique({ where: { id: deposit.id } });
  }

  async function resolvePool(deposit: any) {
    const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
    const targetPool = pools.find((p) => ethers.keccak256(ethers.toUtf8Bytes(p.clubName)) === deposit.poolId);
    if (!targetPool) throw new Error(`No active pool found for poolId hash ${deposit.poolId}`);
    return targetPool;
  }

  async function processChilizDeposit(deposit: any) {
    let current = deposit;
    const polygonProvider = new ethers.JsonRpcProvider(env.RPC_URL);
    const polygonSigner = new ethers.Wallet(env.EXECUTOR_PRIVATE_KEY!, polygonProvider);
    const polygonSignerAddress = await polygonSigner.getAddress();

    if (current.status === "RECEIVED") {
      const chzToUsdRate = parseFloat(process.env.CHZ_TO_USD_RATE || "0.084");
      const chzInEther = parseFloat(ethers.formatEther(current.sourceAmount.toString()));
      const usdcValueUsd = chzInEther * chzToUsdRate;
      const usdcAmountUnits = Math.max(1, Math.floor(usdcValueUsd * 1_000_000));
      const usdcAmount = usdcAmountUnits.toString();
      logger.info({ chzInEther, chzToUsdRate, usdcValueUsd, usdcAmount }, "CHZ -> USDC conversion");

      current = await prisma.cross_chain_deposits.update({
        where: { id: current.id },
        data: { status: "DEPOSITING", usdcAmount, processingStep: null }
      });
    }

    if (current.status === "DEPOSITING") {
      if (!current.usdcAmount) {
        await markManual(current.id, "Chiliz deposit is DEPOSITING but usdcAmount is missing");
        return;
      }

      const targetPool = await resolvePool(current);
      const vault = await getVaultContract(env, polygonProvider as any, {
        clubName: targetPool.clubName,
        vaultAddress: targetPool.vaultAddress ?? undefined
      });

      const assetAddress: string = await (vault as any).asset();
      const usdc = new ethers.Contract(assetAddress, [
        "function approve(address,uint256) external returns (bool)"
      ], polygonSigner);

      const usdcBigInt = decimalToBigInt(current.usdcAmount);
      const vaultAddress: string = (vault as any).target ?? (vault as any).address;

      if (!current.polygonDepositTxHash) {
        if (current.processingStep === POLYGON_DEPOSIT_STEP) {
          await markManual(current.id, "Polygon vault deposit may have been attempted but polygonDepositTxHash is missing");
          return;
        }

        const approveTx = await usdc.approve(vaultAddress, usdcBigInt);
        await approveTx.wait();

        const vaultWithSigner = new ethers.Contract(
          vaultAddress,
          [
            "function deposit(uint256,address) external returns (uint256)",
            "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
          ],
          polygonSigner
        );

        await prisma.cross_chain_deposits.update({
          where: { id: current.id },
          data: { processingStep: POLYGON_DEPOSIT_STEP }
        });

        const depositTx = await vaultWithSigner.deposit(usdcBigInt, polygonSignerAddress);
        await prisma.cross_chain_deposits.update({
          where: { id: current.id },
          data: { polygonDepositTxHash: depositTx.hash }
        });
        const receipt = await requireSuccessfulReceipt(polygonProvider, depositTx.hash, "Polygon vault deposit");
        const sharesMinted = parseVaultSharesFromReceipt(receipt);
        if (!sharesMinted || sharesMinted <= 0n) {
          await markManual(current.id, "Polygon vault deposit completed but minted shares could not be parsed");
          return;
        }

        current = await prisma.cross_chain_deposits.update({
          where: { id: current.id },
          data: {
            status: "MINTING_SHARES",
            sharesMinted: sharesMinted.toString(),
            processingStep: null
          }
        });
      } else if (!current.sharesMinted) {
        const receipt = await requireSuccessfulReceipt(polygonProvider, current.polygonDepositTxHash, "Polygon vault deposit");
        const sharesMinted = parseVaultSharesFromReceipt(receipt);
        if (!sharesMinted || sharesMinted <= 0n) {
          await markManual(current.id, "Polygon vault deposit hash exists but minted shares could not be recovered");
          return;
        }

        current = await prisma.cross_chain_deposits.update({
          where: { id: current.id },
          data: {
            status: "MINTING_SHARES",
            sharesMinted: sharesMinted.toString(),
            processingStep: null
          }
        });
      } else {
        current = await prisma.cross_chain_deposits.update({
          where: { id: current.id },
          data: { status: "MINTING_SHARES", processingStep: null }
        });
      }
    }

    if (current.status === "MINTING_SHARES") {
      if (!current.sharesMinted) {
        await markManual(current.id, "Chiliz deposit is MINTING_SHARES but sharesMinted is missing");
        return;
      }

      if (current.chilizMintTxHash) {
        await requireSuccessfulReceipt(chilizProvider, current.chilizMintTxHash, "Chiliz wrapped share mint");
        await prisma.cross_chain_deposits.update({
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

      if (current.processingStep === CHILIZ_MINT_STEP) {
        await markManual(current.id, "Chiliz wrapped share mint may have been attempted but chilizMintTxHash is missing");
        return;
      }

      const wrappedShareAmount = decimalToBigInt(current.sharesMinted) * SHARE_DECIMAL_BRIDGE_SCALE;
      const depositIdHex = ethers.zeroPadValue(ethers.toBeHex(current.chilizDepositId), 32);

      await prisma.cross_chain_deposits.update({
        where: { id: current.id },
        data: { processingStep: CHILIZ_MINT_STEP }
      });

      const mintTx = await mintWrappedShares(env, current.userAddress, wrappedShareAmount, depositIdHex);
      await prisma.cross_chain_deposits.update({
        where: { id: current.id },
        data: { chilizMintTxHash: mintTx.hash }
      });
      await requireSuccessfulReceipt(chilizProvider, mintTx.hash, "Chiliz wrapped share mint");

      await prisma.cross_chain_deposits.update({
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
        depositId: current.chilizDepositId.toString(),
        user: current.userAddress,
        vaultShares: current.sharesMinted?.toString(),
        wrappedSharesMinted: wrappedShareAmount.toString()
      }, "Chiliz deposit completed - wrapped shares minted");
    }
  }

  async function processOpenDeposits() {
    const pending = await prisma.cross_chain_deposits.findMany({
      where: {
        status: { in: [...ACTIVE_DEPOSIT_STATUSES] },
        OR: [
          { processingLockedAt: null },
          { processingLockedAt: { lt: relayerLockStaleBefore("CHILIZ") } }
        ]
      },
      take: 10,
      orderBy: { createdAt: "asc" }
    });

    const workerId = `chiliz-relayer:${process.pid}:${Date.now()}`;
    for (const deposit of pending) {
      const claimed = await claimDeposit(deposit, workerId);
      if (!claimed) continue;

      try {
        await processChilizDeposit(claimed);
      } catch (err: any) {
        logger.error({ err, depositId: claimed.id }, "Chiliz deposit processing failed");
        await failDeposit(claimed.id, err);
      }
    }
  }

  async function tick() {
    await pollNewDeposits();
    await processOpenDeposits();
  }

  tick()
    .then(() => logger.info("Initial Chiliz relayer tick done"))
    .catch((err) => logger.error({ err }, "Initial Chiliz relayer tick failed"));

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, "Chiliz relayer tick failed"));
  }, intervalMs);
}
