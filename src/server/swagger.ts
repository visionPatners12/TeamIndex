import type { Express } from "express";

const poolId = { name: "poolId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const proposalId = { name: "proposalId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const intentId = { name: "intentId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const redemptionId = { name: "redemptionId", in: "path", required: true, schema: { type: "string", format: "uuid" } };

const adminOperation = (summary: string, parameters: any[] = [poolId]) => ({
  post: {
    tags: ["admin"],
    summary,
    security: [{ adminApiKey: [] }],
    parameters,
    responses: {
      200: { description: "Operation completed" },
      409: { description: "Operation rejected by a fail-closed invariant" },
    },
  },
});

export const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "TeamIndex Polygon / Polymarket V2 API",
    version: "2.0.0",
    description:
      "Polygon pUSD ERC-4626 API. Direct Polymarket trading is fail-closed because the public CLOB API does not document custom TeamIndex ERC-1271 vaults as maker/funder. Deposit Wallet funding is disabled so assets remain in the vault.",
  },
  servers: [{ url: "http://localhost:3001" }],
  components: {
    securitySchemes: {
      adminApiKey: { type: "apiKey", in: "header", name: "x-admin-key" },
    },
    schemas: {
      Address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      BaseUnits: { type: "string", pattern: "^\\d+$", example: "1000000" },
      Transaction: {
        type: "object",
        properties: {
          to: { $ref: "#/components/schemas/Address" },
          data: { type: "string" },
          value: { type: "string", example: "0" },
        },
      },
    },
  },
  tags: [
    { name: "health" },
    { name: "read" },
    { name: "deposits" },
    { name: "redemptions" },
    { name: "admin" },
  ],
  paths: {
    "/health": {
      get: { tags: ["health"], summary: "Runtime and database health", responses: { 200: { description: "OK" } } },
    },
    "/pools": {
      get: { tags: ["read"], summary: "List pools", responses: { 200: { description: "Pools" } } },
    },
    "/teams": {
      get: {
        tags: ["read"],
        summary: "List canonical teams from the shared sports_data schema",
        responses: { 200: { description: "Teams" } },
      },
    },
    "/pools/{poolId}": {
      get: { tags: ["read"], summary: "Get a pool", parameters: [poolId], responses: { 200: { description: "Pool" } } },
    },
    "/pools/{poolId}/nav": {
      get: {
        tags: ["read"],
        summary: "Read Polymarket V2 account, latest accounting snapshot and on-chain NAV",
        parameters: [poolId],
        responses: { 200: { description: "NAV" } },
      },
    },
    "/pools/{poolId}/positions": {
      get: {
        tags: ["read"],
        summary: "Read reconciled Polymarket positions and orders",
        parameters: [poolId],
        responses: { 200: { description: "Positions and orders" } },
      },
    },
    "/pools/{poolId}/price-snapshots/latest": {
      get: {
        tags: ["read"],
        summary: "Read the latest POLYMARKET_V2 valuation snapshot",
        parameters: [poolId],
        responses: { 200: { description: "Snapshot" } },
      },
    },
    "/pools/{poolId}/deposit-intents": {
      post: {
        tags: ["deposits"],
        summary: "Blocked: Deposit Wallet deposits are disabled in Vault-direct custody mode",
        parameters: [poolId],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["idempotencyKey", "userAddress", "depositWalletAddress", "receiverAddress", "assets"],
                properties: {
                  idempotencyKey: { type: "string" },
                  userAddress: { $ref: "#/components/schemas/Address" },
                  depositWalletAddress: { $ref: "#/components/schemas/Address" },
                  receiverAddress: { $ref: "#/components/schemas/Address" },
                  assets: { $ref: "#/components/schemas/BaseUnits" },
                },
              },
            },
          },
        },
        responses: { 201: { description: "Deposit intent and transaction data" }, 409: { description: "Rejected" } },
      },
    },
    "/pools/{poolId}/deposit-intents/{intentId}": {
      get: {
        tags: ["deposits"],
        summary: "Read deposit status",
        parameters: [poolId, intentId],
        responses: { 200: { description: "Deposit intent" } },
      },
    },
    "/pools/{poolId}/deposit-intents/{intentId}/confirm": {
      post: {
        tags: ["deposits"],
        summary: "Verify and settle a direct or escrow deposit transaction",
        parameters: [poolId, intentId],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["txHash", "mode"],
                properties: {
                  txHash: { type: "string" },
                  mode: { type: "string", enum: ["DIRECT", "ESCROW"] },
                },
              },
            },
          },
        },
        responses: { 200: { description: "Confirmed deposit" }, 409: { description: "Invalid transaction" } },
      },
    },
    "/pools/{poolId}/redemptions": {
      post: {
        tags: ["redemptions"],
        summary: "Prepare an asynchronous vault redemption request",
        parameters: [poolId],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ownerAddress", "receiverAddress", "shares"],
                properties: {
                  ownerAddress: { $ref: "#/components/schemas/Address" },
                  receiverAddress: { $ref: "#/components/schemas/Address" },
                  shares: { $ref: "#/components/schemas/BaseUnits" },
                  minAssets: { $ref: "#/components/schemas/BaseUnits" },
                },
              },
            },
          },
        },
        responses: { 201: { description: "Redemption transaction" } },
      },
    },
    "/pools/{poolId}/redemptions/{redemptionId}": {
      get: {
        tags: ["redemptions"],
        summary: "Read redemption status",
        parameters: [poolId, redemptionId],
        responses: { 200: { description: "Redemption" } },
      },
    },
    "/pools/{poolId}/redemptions/{redemptionId}/confirm": {
      post: {
        tags: ["redemptions"],
        summary: "Verify the on-chain redemption request",
        parameters: [poolId, redemptionId],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["txHash"], properties: { txHash: { type: "string" } } },
            },
          },
        },
        responses: { 200: { description: "Confirmed redemption" } },
      },
    },
    "/admin/pools/{poolId}/polymarket/bootstrap": adminOperation("Blocked until Polymarket supports the TeamIndex vault as maker/funder"),
    "/admin/pools/{poolId}/polymarket/approvals": adminOperation("Blocked: Deposit Wallet funding is disabled"),
    "/admin/pools/{poolId}/polymarket/reconcile": adminOperation("Reconcile CLOB state and attest aggregate external valuation"),
    "/admin/pools/{poolId}/polymarket/return-idle": adminOperation("Return idle pUSD from the Deposit Wallet to the vault"),
    "/admin/pools/{poolId}/polymarket/cancel-all": adminOperation("Cancel open CLOB orders and return idle pUSD"),
    "/admin/pools/{poolId}/proposals/{proposalId}/activate": adminOperation(
      "Hash and activate an accepted allocation proposal, then create capped FAK intents",
      [poolId, proposalId],
    ),
    "/admin/polymarket/execute-next": adminOperation("Claim and execute the next idempotent Polymarket trade intent", []),
    "/admin/pools/{poolId}/redemptions/{redemptionId}/make-claimable": adminOperation(
      "Reserve liquid pUSD and make a confirmed redemption claimable",
      [poolId, redemptionId],
    ),
  },
} as const;

export function registerSwaggerDocs(_app: Express) {
  // Swagger UI is mounted by server/http.ts so the signer-only process can
  // reject it before any public application routes are exposed.
}
