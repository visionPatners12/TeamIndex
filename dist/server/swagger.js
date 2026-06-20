"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerSpec = void 0;
exports.registerSwagger = registerSwagger;
exports.swaggerSpec = {
    openapi: "3.0.3",
    info: {
        title: "Club Pool Backend API",
        version: "0.1.0",
        description: "MVP API for club pool asset connected to Limitless markets"
    },
    servers: [{ url: "http://localhost:3001" }],
    components: {
        securitySchemes: {
            adminApiKey: {
                type: "apiKey",
                in: "header",
                name: "x-admin-key",
                description: "Admin API key (set ADMIN_API_KEY)."
            }
        }
    },
    security: [],
    tags: [
        { name: "health" },
        { name: "read" },
        { name: "admin" },
        { name: "limitless" },
        { name: "user-tx" },
        { name: "base" }
    ],
    paths: {
        "/health": {
            get: {
                tags: ["health"],
                summary: "Health check",
                responses: {
                    200: { description: "OK" }
                }
            }
        },
        "/pools": {
            get: {
                tags: ["read"],
                summary: "List all club pools",
                responses: {
                    200: { description: "Array of pools" }
                }
            }
        },
        "/pools/{poolId}": {
            get: {
                tags: ["read"],
                summary: "Get pool",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Pool" } }
            }
        },
        "/pools/{poolId}/candidates": {
            get: {
                tags: ["read"],
                summary: "Get club market candidates",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Candidates" } }
            }
        },
        "/pools/{poolId}/queue": {
            get: {
                tags: ["read"],
                summary: "Get tranche execution queue",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Queue" } }
            }
        },
        "/pools/{poolId}/positions": {
            get: {
                tags: ["read"],
                summary: "Get open positions",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Positions" } }
            }
        },
        "/pools/{poolId}/price-snapshots/latest": {
            get: {
                tags: ["read"],
                summary: "Get latest price snapshot",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Latest snapshot" } }
            }
        },
        "/admin/pools": {
            post: {
                tags: ["admin"],
                summary: "Create pool",
                security: [{ adminApiKey: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    clubName: { type: "string" },
                                    symbol: { type: "string" },
                                    sportsDataTeamId: { type: "string", format: "uuid" },
                                    totalTokenSupply: { type: "number", example: 0 },
                                    deployOnchain: { type: "boolean", example: true, default: false },
                                    depositCap: { type: "string", example: "0" },
                                    riskParams: {
                                        type: "object",
                                        properties: {
                                            maxPerMatchPct: { type: "number", example: 3 },
                                            maxTotalExposurePct: { type: "number", example: 20 },
                                            liquidityMinUsd: { type: "number", example: 50000 }
                                        }
                                    }
                                },
                                required: ["clubName", "symbol", "sportsDataTeamId"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Created poolId" } }
            }
        },
        "/admin/{poolId}/discover": {
            post: {
                tags: ["admin"],
                summary: "Discover eligible Limitless markets by sports_data team id and create candidates",
                security: [{ adminApiKey: [] }],
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    clubName: { type: "string" },
                                    sportsDataTeamId: { type: "string", format: "uuid" },
                                    riskPerMatchPct: { type: "number", example: 3 },
                                    liquidityMinUsd: { type: "number", example: 50000 }
                                },
                                required: ["clubName"]
                            }
                        }
                    }
                },
                responses: {
                    200: { description: "Execution result" },
                    409: { description: "Tranche is already processing/executed or otherwise not executable" }
                }
            }
        },
        "/admin/{poolId}/schedule": {
            post: {
                tags: ["admin"],
                summary: "Create scheduled queue entries (T-48h and T-24h)",
                security: [{ adminApiKey: [] }],
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "OK" } }
            }
        },
        "/admin/{poolId}/execute-tranche": {
            post: {
                tags: ["admin"],
                summary: "Manually execute a tranche (for testing)",
                security: [{ adminApiKey: [] }],
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    candidateId: { type: "string" },
                                    tranche: { type: "number", enum: [1, 2] }
                                },
                                required: ["candidateId", "tranche"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "OK" } }
            }
        },
        "/admin/{poolId}/pause": {
            post: {
                tags: ["admin"],
                summary: "Pause vault (onchain)",
                security: [{ adminApiKey: [] }],
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "OK" } }
            }
        },
        "/admin/{poolId}/unpause": {
            post: {
                tags: ["admin"],
                summary: "Unpause vault (onchain)",
                security: [{ adminApiKey: [] }],
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "OK" } }
            }
        },
        "/pools/{poolId}/tx/deposit": {
            post: {
                tags: ["user-tx"],
                summary: "Prepare ERC4626 deposit transaction (populateTransaction)",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    assets: { type: "string", example: "1000000" },
                                    receiver: { type: "string" }
                                },
                                required: ["assets", "receiver"]
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: "Prepared native Polygon USDC approval and ERC4626 deposit transactions",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        ok: { type: "boolean" },
                                        vaultAddress: { type: "string" },
                                        assetAddress: { type: "string" },
                                        tx: { type: "object" },
                                        txs: {
                                            type: "object",
                                            properties: {
                                                approveTx: { type: "object" },
                                                depositTx: { type: "object" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    409: {
                        description: "Pool vault asset is not the configured native Polygon USDC address",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        ok: { type: "boolean", example: false },
                                        code: { type: "string", example: "VAULT_ASSET_MISMATCH" },
                                        error: { type: "string" },
                                        vaultAddress: { type: "string" },
                                        assetAddress: { type: "string" },
                                        expectedAssetAddress: { type: "string" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        "/pools/{poolId}/tx/deposit-wrapchz": {
            post: {
                tags: ["user-tx"],
                summary: "Prepare WrapCHZ->USDC swap + vault deposit txs (unsigned)",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    sender: { type: "string", description: "Swap output recipient (signing wallet address)" },
                                    receiver: { type: "string", description: "Vault share receiver" },
                                    wrapChzAmountIn: { type: "string", example: "1000000000000000000" },
                                    usdcAmountOutMin: { type: "string", example: "1000000" },
                                    depositAssets: { type: "string", example: "1000000", description: "Optional; defaults to usdcAmountOutMin" }
                                },
                                required: ["sender", "receiver", "wrapChzAmountIn", "usdcAmountOutMin"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Sequence of TransactionRequests" } }
            }
        },
        "/base/tx/deposit-usdc": {
            post: {
                tags: ["base"],
                summary: "Prepare unsigned approve + Base USDC deposit transactions",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    poolId: { type: "string" },
                                    amount: { type: "string", example: "1000000" }
                                },
                                required: ["poolId", "amount"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Base approve/deposit TransactionRequests" } }
            }
        },
        "/base/deposits/{depositId}": {
            get: {
                tags: ["base"],
                summary: "Get Base deposit status",
                parameters: [{ name: "depositId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Deposit status" } }
            }
        },
        "/base/deposits/confirm": {
            post: {
                tags: ["base"],
                summary: "Confirm and ingest a successful Base deposit transaction",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    txHash: { type: "string", example: "0xd33d703c9592e377c02c9c7b2ccfc30c3ae4579c7570cb30a1f638f88a49f878" }
                                },
                                required: ["txHash"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Ingested Base deposit rows" } }
            }
        },
        "/base/deposits/user/{userAddress}": {
            get: {
                tags: ["base"],
                summary: "List Base deposits for a user",
                parameters: [{ name: "userAddress", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Deposits" } }
            }
        },
        "/admin/base/retry-failed": {
            post: {
                tags: ["admin", "base"],
                summary: "Safely retry FAILED Base deposits from their persisted stage",
                security: [{ adminApiKey: [] }],
                responses: { 200: { description: "Retry summary with retried/manual/completed counts" } }
            }
        },
        "/admin/base/reset-failed": {
            post: {
                tags: ["admin", "base"],
                summary: "Deprecated alias for safe Base retry; does not reset to RECEIVED",
                security: [{ adminApiKey: [] }],
                responses: { 200: { description: "Retry summary with deprecated=true" } }
            }
        },
        "/pools/{poolId}/tx/mint": {
            post: {
                tags: ["user-tx"],
                summary: "Prepare ERC4626 mint transaction (populateTransaction)",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    shares: { type: "string", example: "1000000" },
                                    receiver: { type: "string" }
                                },
                                required: ["shares", "receiver"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "TransactionRequest" } }
            }
        },
        "/pools/{poolId}/tx/withdraw": {
            post: {
                tags: ["user-tx"],
                summary: "Prepare ERC4626 withdraw transaction (populateTransaction)",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    assets: { type: "string", example: "1000000" },
                                    receiver: { type: "string" },
                                    owner: { type: "string" }
                                },
                                required: ["assets", "receiver", "owner"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "TransactionRequest" } }
            }
        },
        "/pools/{poolId}/tx/redeem": {
            post: {
                tags: ["user-tx"],
                summary: "Prepare ERC4626 redeem transaction (populateTransaction)",
                parameters: [{ name: "poolId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    shares: { type: "string", example: "1000000" },
                                    receiver: { type: "string" },
                                    owner: { type: "string" }
                                },
                                required: ["shares", "receiver", "owner"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "TransactionRequest" } }
            }
        },
        "/chiliz/tx/deposit-chz": {
            post: {
                tags: ["chiliz"],
                summary: "Prepare unsigned tx for depositCHZ on Chiliz chain",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    poolId: { type: "string", description: "Backend pool ID" }
                                },
                                required: ["poolId"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Unsigned tx for depositCHZ" } }
            }
        },
        "/chiliz/tx/deposit-token": {
            post: {
                tags: ["chiliz"],
                summary: "Prepare unsigned txs (approve + depositToken) on Chiliz chain",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    poolId: { type: "string" },
                                    token: { type: "string", description: "Fan token address on Chiliz" },
                                    amount: { type: "string", example: "1000000000000000000" }
                                },
                                required: ["poolId", "token", "amount"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Unsigned txs (approve + deposit)" } }
            }
        },
        "/chiliz/deposits/{depositId}": {
            get: {
                tags: ["chiliz"],
                summary: "Get cross-chain deposit status",
                parameters: [{ name: "depositId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Deposit record with status" } }
            }
        },
        "/chiliz/deposits/user/{userAddress}": {
            get: {
                tags: ["chiliz"],
                summary: "List cross-chain deposits for a user",
                parameters: [{ name: "userAddress", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Array of deposit records" } }
            }
        },
        "/admin/chiliz/retry-failed": {
            post: {
                tags: ["admin", "chiliz"],
                summary: "Safely retry FAILED Chiliz deposits from their persisted stage",
                security: [{ adminApiKey: [] }],
                responses: { 200: { description: "Retry summary with retried/manual/completed counts" } }
            }
        },
        "/admin/chiliz/reset-failed": {
            post: {
                tags: ["admin", "chiliz"],
                summary: "Deprecated alias for safe Chiliz retry; does not reset to RECEIVED",
                security: [{ adminApiKey: [] }],
                responses: { 200: { description: "Retry summary with deprecated=true" } }
            }
        },
        "/chiliz/redeem": {
            post: {
                tags: ["chiliz"],
                summary: "Request redemption: burn wrapped shares on Chiliz",
                security: [{ adminApiKey: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    poolId: { type: "string" },
                                    userAddress: { type: "string" },
                                    shares: { type: "string", example: "1000000000000000000" }
                                },
                                required: ["poolId", "userAddress", "shares"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Redemption record" } }
            }
        },
        "/chiliz/redemptions/{redemptionId}": {
            get: {
                tags: ["chiliz"],
                summary: "Get redemption status",
                parameters: [{ name: "redemptionId", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "Redemption record with status" } }
            }
        }
    }
};
function registerSwagger(app) {
    // Client/renderer is done in http.ts. This file only exports spec.
}
