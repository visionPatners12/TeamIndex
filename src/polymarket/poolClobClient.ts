import {
  Chain,
  ClobClient,
  SignatureTypeV2,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import type { Env } from "../config/env";
import { decryptPoolCredential } from "./credentialCrypto";
import { createPolymarketSigner } from "./remoteSigner";

export type StoredPoolPolymarketAccount = {
  poolId: string;
  cdpOwnerAddress: string;
  depositWalletAddress: string;
  vaultAddress: string;
  clobApiKeyCiphertext: string | null;
  clobSecretCiphertext: string | null;
  clobPassphraseCiphertext: string | null;
};

export function readPoolClobCredentials(
  env: Env,
  account: StoredPoolPolymarketAccount,
): ApiKeyCreds {
  if (
    !account.clobApiKeyCiphertext
    || !account.clobSecretCiphertext
    || !account.clobPassphraseCiphertext
  ) {
    throw new Error(`Polymarket CLOB credentials are not initialized for pool ${account.poolId}`);
  }
  return {
    key: decryptPoolCredential(env, account.poolId, "apiKey", account.clobApiKeyCiphertext),
    secret: decryptPoolCredential(env, account.poolId, "secret", account.clobSecretCiphertext),
    passphrase: decryptPoolCredential(
      env,
      account.poolId,
      "passphrase",
      account.clobPassphraseCiphertext,
    ),
  };
}

export function createPoolClobClient(env: Env, account: StoredPoolPolymarketAccount) {
  const signer = createPolymarketSigner(env, account.poolId, {
    ownerAddress: account.cdpOwnerAddress,
    depositWalletAddress: account.depositWalletAddress,
    vaultAddress: account.vaultAddress,
  });
  return new ClobClient({
    host: env.POLYMARKET_CLOB_URL,
    chain: Chain.POLYGON,
    signer: signer as any,
    creds: readPoolClobCredentials(env, account),
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: account.depositWalletAddress,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true,
    builderConfig: env.POLYMARKET_BUILDER_CODE
      ? { builderCode: env.POLYMARKET_BUILDER_CODE }
      : undefined,
  });
}
