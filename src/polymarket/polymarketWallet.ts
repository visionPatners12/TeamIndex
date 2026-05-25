import { ethers } from "ethers";
import type { Env } from "../config/env";
import { ERC20 } from "../contracts/erc20";

export const POLYGON_CHAIN_ID = 137;
export const POLY_1271_SIGNATURE_TYPE = 3;
const DEPOSIT_WALLET_TX_DEADLINE_SECONDS = 240;

type Hex = `0x${string}`;

type MissingConfigScope = "clob" | "builder" | "readiness";

type TokenBalanceRead = {
  raw: string;
  formatted: string;
  decimals: number;
};

type AllowanceRead = {
  spender: string;
  raw: string;
  formatted: string;
};

export type PolymarketReadiness = {
  ok: boolean;
  tradingReady: boolean;
  reasons: string[];
  missingConfig: string[];
  signatureType: number | null;
  signerAddress?: string;
  funderAddress?: string;
  contracts: {
    depositWalletFactory: string;
    pusdAddress: string;
    ctfExchange: string;
    negRiskCtfExchange: string;
  };
  clobCredentials: {
    configured: boolean;
    valid?: boolean;
    error?: string;
  };
  depositWallet: {
    configured: boolean;
    derivedAddress?: string;
    deployed?: boolean;
    code?: string;
    error?: string;
  };
  balances?: {
    pusd: TokenBalanceRead;
    ctfAllowance: AllowanceRead;
    negRiskCtfAllowance: AllowanceRead;
  };
  market?: {
    tokenId: string;
    tickSize?: string;
    negRisk?: boolean;
    error?: string;
  };
};

export function normalizePrivateKey(privateKey: string): Hex {
  const trimmed = privateKey.trim();
  if (!trimmed) throw new Error("EXECUTOR_PRIVATE_KEY missing");
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

export function getPolymarketSignatureType(env: Env): number | null {
  const raw = env.POLY_SIGNATURE_TYPE ?? String(POLY_1271_SIGNATURE_TYPE);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getPolymarketMissingConfig(env: Env, scope: MissingConfigScope = "readiness"): string[] {
  const missing: string[] = [];

  if (!env.EXECUTOR_PRIVATE_KEY) missing.push("EXECUTOR_PRIVATE_KEY");

  if (scope === "clob" || scope === "readiness") {
    if (!env.POLY_API_KEY) missing.push("POLY_API_KEY");
    if (!env.POLY_PASSPHRASE) missing.push("POLY_PASSPHRASE");
    if (!env.POLY_SIGNATURE_SECRET) missing.push("POLY_SIGNATURE_SECRET");
  }

  if (scope === "builder") {
    if (!env.POLY_BUILDER_API_KEY) missing.push("POLY_BUILDER_API_KEY");
    if (!env.POLY_BUILDER_SECRET) missing.push("POLY_BUILDER_SECRET");
    if (!env.POLY_BUILDER_PASSPHRASE) missing.push("POLY_BUILDER_PASSPHRASE");
  }

  if (scope === "readiness") {
    if (!env.RPC_URL) missing.push("RPC_URL");
    if (!env.POLY_PUSD_ADDRESS) missing.push("POLY_PUSD_ADDRESS");
    if (!env.POLY_CTF_EXCHANGE) missing.push("POLY_CTF_EXCHANGE");
    if (!env.POLY_NEG_RISK_CTF_EXCHANGE) missing.push("POLY_NEG_RISK_CTF_EXCHANGE");
  }

  return missing;
}

export function assertPolymarketClobConfig(env: Env) {
  const missing = getPolymarketMissingConfig(env, "clob");
  if (missing.length) throw new Error(`Missing Polymarket CLOB config: ${missing.join(", ")}`);

  const signatureType = getPolymarketSignatureType(env);
  if (signatureType !== POLY_1271_SIGNATURE_TYPE) {
    throw new Error("POLY_SIGNATURE_TYPE must be 3 (POLY_1271) for Deposit Wallet trading");
  }
}

export async function resolvePolymarketFunderAddress(env: Env): Promise<string> {
  if (env.POLY_FUNDER_ADDRESS?.trim()) return env.POLY_FUNDER_ADDRESS.trim();
  const derived = await derivePolymarketDepositWallet(env);
  return derived.depositWalletAddress;
}

export async function createPolymarketWalletClient(env: Env) {
  if (!env.EXECUTOR_PRIVATE_KEY) throw new Error("EXECUTOR_PRIVATE_KEY missing");

  const [{ createWalletClient, http }, { privateKeyToAccount }, { polygon }] = await Promise.all([
    import("viem"),
    import("viem/accounts"),
    import("viem/chains")
  ]);

  const account = privateKeyToAccount(normalizePrivateKey(env.EXECUTOR_PRIVATE_KEY));
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(env.RPC_URL)
  });
}

async function createBuilderConfig(env: Env) {
  const missing = getPolymarketMissingConfig(env, "builder");
  if (missing.length) throw new Error(`Missing Polymarket builder relayer config: ${missing.join(", ")}`);

  const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");
  return new BuilderConfig({
    localBuilderCreds: {
      key: env.POLY_BUILDER_API_KEY!,
      secret: env.POLY_BUILDER_SECRET!,
      passphrase: env.POLY_BUILDER_PASSPHRASE!
    }
  });
}

async function createRelayClient(env: Env, requireBuilderAuth = false) {
  const [{ RelayClient }, walletClient] = await Promise.all([
    import("@polymarket/builder-relayer-client"),
    createPolymarketWalletClient(env)
  ]);
  const builderConfig = requireBuilderAuth ? await createBuilderConfig(env) : undefined;
  const relay = new RelayClient(env.POLY_RELAYER_URL, POLYGON_CHAIN_ID, walletClient as any, builderConfig as any);
  if (env.POLY_DEPOSIT_WALLET_FACTORY) {
    (relay as any).contractConfig.DepositWalletContracts.DepositWalletFactory = env.POLY_DEPOSIT_WALLET_FACTORY;
  }
  return relay;
}

export async function derivePolymarketDepositWallet(env: Env): Promise<{
  signerAddress: string;
  depositWalletAddress: string;
  recommendedEnv: string;
}> {
  const relay = await createRelayClient(env);
  const walletClient = await createPolymarketWalletClient(env);
  const [depositWalletAddress] = await Promise.all([relay.deriveDepositWalletAddress()]);
  const signerAddress = walletClient.account?.address;
  if (!signerAddress) throw new Error("Unable to resolve Polymarket signer address");

  return {
    signerAddress,
    depositWalletAddress,
    recommendedEnv: `POLY_FUNDER_ADDRESS=${depositWalletAddress}`
  };
}

export async function deployPolymarketDepositWallet(env: Env): Promise<{
  signerAddress: string;
  depositWalletAddress: string;
  transactionID?: string;
  transactionHash?: string;
  state?: string;
  deployed?: boolean;
}> {
  const relay = await createRelayClient(env, true);
  const derived = await derivePolymarketDepositWallet(env);
  const response = await relay.deployDepositWallet();
  const mined = typeof response.wait === "function" ? await response.wait() : undefined;

  return {
    signerAddress: derived.signerAddress,
    depositWalletAddress: derived.depositWalletAddress,
    transactionID: response.transactionID,
    transactionHash: mined?.transactionHash ?? response.transactionHash ?? response.hash,
    state: mined?.state ?? response.state,
    deployed: mined ? mined.state === "STATE_MINED" || mined.state === "STATE_CONFIRMED" : undefined
  };
}

async function readDepositWalletCode(env: Env, depositWalletAddress: string): Promise<string> {
  if (!env.RPC_URL) throw new Error("RPC_URL missing (needed to check Deposit Wallet deployment)");
  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  return provider.getCode(depositWalletAddress);
}

export async function ensurePolymarketDepositWalletDeployed(env: Env): Promise<{
  signerAddress: string;
  depositWalletAddress: string;
  alreadyDeployed: boolean;
  transactionID?: string;
  transactionHash?: string;
  state?: string;
}> {
  const derived = await derivePolymarketDepositWallet(env);
  const code = await readDepositWalletCode(env, derived.depositWalletAddress);
  if (code !== "0x") {
    return {
      signerAddress: derived.signerAddress,
      depositWalletAddress: derived.depositWalletAddress,
      alreadyDeployed: true
    };
  }

  const deployed = await deployPolymarketDepositWallet(env);
  return {
    signerAddress: deployed.signerAddress,
    depositWalletAddress: deployed.depositWalletAddress,
    alreadyDeployed: false,
    transactionID: deployed.transactionID,
    transactionHash: deployed.transactionHash,
    state: deployed.state
  };
}

async function readPusdAllowances(env: Env, depositWalletAddress: string) {
  if (!env.RPC_URL) throw new Error("RPC_URL missing (needed to read pUSD allowances)");
  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  const pusd = new ethers.Contract(env.POLY_PUSD_ADDRESS, ERC20.abi, provider);
  const [decimals, balanceRaw, ctfAllowanceRaw, negRiskAllowanceRaw] = await Promise.all([
    pusd.decimals().then((v: bigint | number) => Number(v)).catch(() => 6),
    pusd.balanceOf(depositWalletAddress) as Promise<bigint>,
    pusd.allowance(depositWalletAddress, env.POLY_CTF_EXCHANGE) as Promise<bigint>,
    pusd.allowance(depositWalletAddress, env.POLY_NEG_RISK_CTF_EXCHANGE) as Promise<bigint>
  ]);

  return { decimals, balanceRaw, ctfAllowanceRaw, negRiskAllowanceRaw };
}

function formatTokenAmount(raw: bigint, decimals: number): TokenBalanceRead {
  return {
    raw: raw.toString(),
    formatted: ethers.formatUnits(raw, decimals),
    decimals
  };
}

function formatAllowance(spender: string, raw: bigint, decimals: number): AllowanceRead {
  return {
    spender,
    raw: raw.toString(),
    formatted: ethers.formatUnits(raw, decimals)
  };
}

function createApproveCall(tokenAddress: string, spenderAddress: string) {
  const erc20Interface = new ethers.Interface(ERC20.abi);
  return {
    target: tokenAddress,
    value: "0",
    data: erc20Interface.encodeFunctionData("approve", [spenderAddress, ethers.MaxUint256])
  };
}

export async function approvePolymarketPusdAllowances(env: Env): Promise<{
  depositWalletAddress: string;
  approvalsNeeded: string[];
  alreadyApproved: boolean;
  transactionID?: string;
  transactionHash?: string;
  state?: string;
  before: {
    pusd: TokenBalanceRead;
    ctfAllowance: AllowanceRead;
    negRiskCtfAllowance: AllowanceRead;
  };
  after?: {
    pusd: TokenBalanceRead;
    ctfAllowance: AllowanceRead;
    negRiskCtfAllowance: AllowanceRead;
  };
}> {
  const deployment = await ensurePolymarketDepositWalletDeployed(env);
  const beforeRaw = await readPusdAllowances(env, deployment.depositWalletAddress);
  const before = {
    pusd: formatTokenAmount(beforeRaw.balanceRaw, beforeRaw.decimals),
    ctfAllowance: formatAllowance(env.POLY_CTF_EXCHANGE, beforeRaw.ctfAllowanceRaw, beforeRaw.decimals),
    negRiskCtfAllowance: formatAllowance(env.POLY_NEG_RISK_CTF_EXCHANGE, beforeRaw.negRiskAllowanceRaw, beforeRaw.decimals)
  };

  const calls = [];
  const approvalsNeeded: string[] = [];
  if (beforeRaw.ctfAllowanceRaw === 0n) {
    approvalsNeeded.push(env.POLY_CTF_EXCHANGE);
    calls.push(createApproveCall(env.POLY_PUSD_ADDRESS, env.POLY_CTF_EXCHANGE));
  }
  if (beforeRaw.negRiskAllowanceRaw === 0n) {
    approvalsNeeded.push(env.POLY_NEG_RISK_CTF_EXCHANGE);
    calls.push(createApproveCall(env.POLY_PUSD_ADDRESS, env.POLY_NEG_RISK_CTF_EXCHANGE));
  }

  if (calls.length === 0) {
    return {
      depositWalletAddress: deployment.depositWalletAddress,
      approvalsNeeded,
      alreadyApproved: true,
      before
    };
  }

  const relay = await createRelayClient(env, true);
  const deadline = Math.floor(Date.now() / 1000 + DEPOSIT_WALLET_TX_DEADLINE_SECONDS).toString();
  const response = await relay.executeDepositWalletBatch(calls, deployment.depositWalletAddress, deadline);
  const mined = typeof response.wait === "function" ? await response.wait() : undefined;

  const afterRaw = await readPusdAllowances(env, deployment.depositWalletAddress);
  const after = {
    pusd: formatTokenAmount(afterRaw.balanceRaw, afterRaw.decimals),
    ctfAllowance: formatAllowance(env.POLY_CTF_EXCHANGE, afterRaw.ctfAllowanceRaw, afterRaw.decimals),
    negRiskCtfAllowance: formatAllowance(env.POLY_NEG_RISK_CTF_EXCHANGE, afterRaw.negRiskAllowanceRaw, afterRaw.decimals)
  };

  return {
    depositWalletAddress: deployment.depositWalletAddress,
    approvalsNeeded,
    alreadyApproved: false,
    transactionID: response.transactionID,
    transactionHash: mined?.transactionHash ?? response.transactionHash ?? response.hash,
    state: mined?.state ?? response.state,
    before,
    after
  };
}

export async function bootstrapPolymarketTradingWallet(env: Env, tokenId?: string): Promise<{
  depositWallet: Awaited<ReturnType<typeof ensurePolymarketDepositWalletDeployed>>;
  approvals: Awaited<ReturnType<typeof approvePolymarketPusdAllowances>>;
  readiness: PolymarketReadiness;
}> {
  const depositWallet = await ensurePolymarketDepositWalletDeployed(env);
  const approvals = await approvePolymarketPusdAllowances(env);
  const readiness = await getPolymarketReadiness(
    {
      ...env,
      POLY_FUNDER_ADDRESS: env.POLY_FUNDER_ADDRESS?.trim() || depositWallet.depositWalletAddress
    },
    tokenId
  );

  return { depositWallet, approvals, readiness };
}

async function getPublicClobMarketMetadata(env: Env, tokenId: string) {
  const { Chain, ClobClient } = await import("@polymarket/clob-client-v2");
  const sdk = new ClobClient({
    host: env.CLOB_BASE_URL,
    chain: Chain.POLYGON,
    throwOnError: true
  });

  const [tickSize, negRisk] = await Promise.all([sdk.getTickSize(tokenId), sdk.getNegRisk(tokenId)]);
  return { tickSize, negRisk };
}

async function checkClobCredentials(env: Env): Promise<PolymarketReadiness["clobCredentials"]> {
  const missing = getPolymarketMissingConfig(env, "clob");
  if (missing.some((key) => key !== "POLY_FUNDER_ADDRESS")) {
    return { configured: false, valid: false, error: `Missing ${missing.join(", ")}` };
  }

  try {
    assertPolymarketClobConfig(env);
    const { Chain, ClobClient, SignatureTypeV2 } = await import("@polymarket/clob-client-v2");
    const [signer, funderAddress] = await Promise.all([
      createPolymarketWalletClient(env),
      resolvePolymarketFunderAddress(env)
    ]);
    const client = new ClobClient({
      host: env.CLOB_BASE_URL,
      chain: Chain.POLYGON,
      signer,
      creds: {
        key: env.POLY_API_KEY!,
        secret: env.POLY_SIGNATURE_SECRET!,
        passphrase: env.POLY_PASSPHRASE!
      },
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress,
      useServerTime: true,
      throwOnError: true
    });
    await client.getApiKeys();
    return { configured: true, valid: true };
  } catch (err: any) {
    return { configured: true, valid: false, error: err?.message ?? String(err) };
  }
}

function zeroAllowance(spender: string): AllowanceRead {
  return { spender, raw: "0", formatted: "0" };
}

export async function getPolymarketReadiness(env: Env, tokenId?: string): Promise<PolymarketReadiness> {
  const reasons: string[] = [];
  const missingConfig = getPolymarketMissingConfig(env, "readiness");
  const signatureType = getPolymarketSignatureType(env);
  const funderAddress = env.POLY_FUNDER_ADDRESS?.trim();

  const readiness: PolymarketReadiness = {
    ok: true,
    tradingReady: false,
    reasons,
    missingConfig,
    signatureType,
    funderAddress,
    contracts: {
      depositWalletFactory: env.POLY_DEPOSIT_WALLET_FACTORY,
      pusdAddress: env.POLY_PUSD_ADDRESS,
      ctfExchange: env.POLY_CTF_EXCHANGE,
      negRiskCtfExchange: env.POLY_NEG_RISK_CTF_EXCHANGE
    },
    clobCredentials: { configured: missingConfig.length === 0 },
    depositWallet: { configured: Boolean(funderAddress) }
  };

  if (signatureType !== POLY_1271_SIGNATURE_TYPE) {
    reasons.push("POLY_SIGNATURE_TYPE must be 3 (POLY_1271)");
  }

  if (missingConfig.length) {
    reasons.push(`Missing config: ${missingConfig.join(", ")}`);
  }

  try {
    const walletClient = await createPolymarketWalletClient(env);
    readiness.signerAddress = walletClient.account?.address;
    const derived = await derivePolymarketDepositWallet(env);
    readiness.depositWallet.derivedAddress = derived.depositWalletAddress;
    readiness.funderAddress = funderAddress || derived.depositWalletAddress;
    readiness.depositWallet.configured = true;

    if (funderAddress && derived.depositWalletAddress.toLowerCase() !== funderAddress.toLowerCase()) {
      reasons.push("POLY_FUNDER_ADDRESS does not match the Deposit Wallet derived from EXECUTOR_PRIVATE_KEY");
    }
  } catch (err: any) {
    readiness.depositWallet.error = err?.message ?? String(err);
    if (!missingConfig.includes("EXECUTOR_PRIVATE_KEY")) {
      reasons.push(`Deposit Wallet derivation failed: ${readiness.depositWallet.error}`);
    }
  }

  readiness.clobCredentials = await checkClobCredentials(env);
  if (!readiness.clobCredentials.valid) {
    reasons.push(`CLOB credentials not ready: ${readiness.clobCredentials.error ?? "invalid credentials"}`);
  }

  if (tokenId) {
    readiness.market = { tokenId };
    try {
      const metadata = await getPublicClobMarketMetadata(env, tokenId);
      readiness.market.tickSize = metadata.tickSize;
      readiness.market.negRisk = metadata.negRisk;
    } catch (err: any) {
      readiness.market.error = err?.message ?? String(err);
      reasons.push(`Market metadata not ready: ${readiness.market.error}`);
    }
  }

  const effectiveFunderAddress = readiness.funderAddress;
  if (env.RPC_URL && effectiveFunderAddress && env.POLY_PUSD_ADDRESS && env.POLY_CTF_EXCHANGE && env.POLY_NEG_RISK_CTF_EXCHANGE) {
    try {
      const provider = new ethers.JsonRpcProvider(env.RPC_URL);
      const code = await provider.getCode(effectiveFunderAddress);
      readiness.depositWallet.code = code;
      readiness.depositWallet.deployed = code !== "0x";
      if (code === "0x") reasons.push("Deposit Wallet is not deployed on Polygon");

      const { decimals, balanceRaw, ctfAllowanceRaw, negRiskAllowanceRaw } = await readPusdAllowances(env, effectiveFunderAddress);

      readiness.balances = {
        pusd: formatTokenAmount(balanceRaw, decimals),
        ctfAllowance: formatAllowance(env.POLY_CTF_EXCHANGE, ctfAllowanceRaw, decimals),
        negRiskCtfAllowance: formatAllowance(env.POLY_NEG_RISK_CTF_EXCHANGE, negRiskAllowanceRaw, decimals)
      };

      if (balanceRaw === 0n) reasons.push("pUSD balance is zero");
      if (ctfAllowanceRaw === 0n) reasons.push("pUSD allowance to CTF Exchange is zero");
      if (negRiskAllowanceRaw === 0n) reasons.push("pUSD allowance to Neg Risk CTF Exchange is zero");
    } catch (err: any) {
      readiness.depositWallet.error = readiness.depositWallet.error ?? (err?.message ?? String(err));
      reasons.push(`Onchain pUSD readiness failed: ${err?.message ?? String(err)}`);
      readiness.balances = {
        pusd: { raw: "0", formatted: "0", decimals: 6 },
        ctfAllowance: zeroAllowance(env.POLY_CTF_EXCHANGE),
        negRiskCtfAllowance: zeroAllowance(env.POLY_NEG_RISK_CTF_EXCHANGE)
      };
    }
  }

  readiness.ok = readiness.missingConfig.length === 0 && !readiness.depositWallet.error;
  readiness.tradingReady =
    readiness.ok &&
    readiness.clobCredentials.valid === true &&
    readiness.depositWallet.deployed === true &&
    Boolean(readiness.balances && BigInt(readiness.balances.pusd.raw) > 0n) &&
    Boolean(readiness.balances && BigInt(readiness.balances.ctfAllowance.raw) > 0n) &&
    Boolean(readiness.balances && BigInt(readiness.balances.negRiskCtfAllowance.raw) > 0n) &&
    (!tokenId || Boolean(readiness.market?.tickSize && readiness.market.error === undefined)) &&
    reasons.length === 0;

  return readiness;
}
