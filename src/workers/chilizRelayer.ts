import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { ethers } from "ethers";
import { getDepositReceiverContract, mintWrappedShares, getChilizProvider } from "../onchain/chilizExecutor";
import { getVaultContract } from "../onchain/vaultExecutor";

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
    const events = await receiver.queryFilter(filter, fromBlock, toBlock);

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

  async function processReceivedDeposits() {
    const pending = await prisma.cross_chain_deposits.findMany({
      where: { status: "RECEIVED" },
      take: 10,
      orderBy: { createdAt: "asc" }
    });

    const polygonProvider = new ethers.JsonRpcProvider(env.RPC_URL);
    const polygonSigner = new ethers.Wallet(env.EXECUTOR_PRIVATE_KEY!, polygonProvider);

    for (const deposit of pending) {
      try {
        await prisma.cross_chain_deposits.update({
          where: { id: deposit.id },
          data: { status: "BRIDGING" }
        });

        const chzToUsdRate = parseFloat(process.env.CHZ_TO_USD_RATE || "0.084");
        const chzInEther = parseFloat(ethers.formatEther(deposit.sourceAmount.toString()));
        const usdcValueUsd = chzInEther * chzToUsdRate;
        const usdcAmountUnits = Math.max(1, Math.floor(usdcValueUsd * 1_000_000));
        const usdcAmount = usdcAmountUnits.toString();
        logger.info({ chzInEther, chzToUsdRate, usdcValueUsd, usdcAmount }, "CHZ → USDC conversion");

        await prisma.cross_chain_deposits.update({
          where: { id: deposit.id },
          data: { status: "DEPOSITING", usdcAmount }
        });

        const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
        const targetPool = pools.find(p => {
          const hash = ethers.keccak256(ethers.toUtf8Bytes(p.clubName));
          return hash === deposit.poolId;
        });

        if (!targetPool) {
          throw new Error(`No active pool found for poolId hash ${deposit.poolId}`);
        }

        const vault = await getVaultContract(env, polygonProvider as any, {
          clubName: targetPool.clubName,
          vaultAddress: targetPool.vaultAddress ?? undefined
        });

        const assetAddress: string = await (vault as any).asset();
        const usdc = new ethers.Contract(assetAddress, [
          "function approve(address,uint256) external returns (bool)"
        ], polygonSigner);

        const usdcBigInt = BigInt(usdcAmount);
        const vaultAddress: string = (vault as any).target ?? (vault as any).address;

        const approveTx = await usdc.approve(vaultAddress, usdcBigInt);
        await approveTx.wait();

        const vaultWithSigner = new ethers.Contract(
          vaultAddress,
          ["function deposit(uint256,address) external returns (uint256)"],
          polygonSigner
        );

        const depositTx = await vaultWithSigner.deposit(usdcBigInt, await polygonSigner.getAddress());
        const receipt = await depositTx.wait();

        const vaultSharesInterface = new ethers.Interface([
          "event VaultDeposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
        ]);
        let sharesMinted = BigInt(0);
        for (const log of receipt.logs) {
          try {
            const parsed = vaultSharesInterface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed && parsed.name === "VaultDeposit") {
              sharesMinted = parsed.args.shares;
              break;
            }
          } catch { /* skip non-matching logs */ }
        }

        await prisma.cross_chain_deposits.update({
          where: { id: deposit.id },
          data: {
            status: "MINTING_SHARES",
            polygonDepositTxHash: receipt.hash,
            sharesMinted: sharesMinted.toString()
          }
        });

        const wrappedShareAmount = sharesMinted * (10n ** 12n);

        const depositIdHex = ethers.zeroPadValue(ethers.toBeHex(deposit.chilizDepositId), 32);
        const mintTx = await mintWrappedShares(env, deposit.userAddress, wrappedShareAmount, depositIdHex);
        const mintReceipt = await mintTx.wait();

        await prisma.cross_chain_deposits.update({
          where: { id: deposit.id },
          data: {
            status: "COMPLETED",
            chilizMintTxHash: mintReceipt?.hash ?? mintTx.hash
          }
        });

        logger.info({
          depositId: deposit.chilizDepositId.toString(),
          user: deposit.userAddress,
          vaultShares: sharesMinted.toString(),
          wrappedSharesMinted: wrappedShareAmount.toString()
        }, "Chiliz deposit completed — wrapped shares minted");

      } catch (err: any) {
        logger.error({ err, depositId: deposit.id }, "Chiliz deposit processing failed");
        await prisma.cross_chain_deposits.update({
          where: { id: deposit.id },
          data: { status: "FAILED", lastError: err.message?.slice(0, 500) }
        });
      }
    }
  }

  async function tick() {
    await pollNewDeposits();
    await processReceivedDeposits();
  }

  tick()
    .then(() => logger.info("Initial Chiliz relayer tick done"))
    .catch((err) => logger.error({ err }, "Initial Chiliz relayer tick failed"));

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, "Chiliz relayer tick failed"));
  }, intervalMs);
}
