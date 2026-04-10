"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerSpec = void 0;
exports.registerSwagger = registerSwagger;
exports.swaggerSpec = {
    openapi: "3.0.3",
    info: {
        title: "Club Pool Backend API",
        version: "0.1.0",
        description: "MVP API for club pool asset connected to Polymarket"
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
        { name: "user-tx" }
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
                                    totalTokenSupply: { type: "number", example: 0 },
                                    deployOnchain: { type: "boolean", example: true, default: true },
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
                                required: ["clubName", "symbol"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "Created poolId" } }
            }
        },
        "/admin/club-team-map": {
            post: {
                tags: ["admin"],
                summary: "Set club -> Polymarket team mapping",
                security: [{ adminApiKey: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    internalClubName: { type: "string" },
                                    polymarketTeamId: { type: "string" }
                                },
                                required: ["internalClubName", "polymarketTeamId"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "OK" } }
            }
        },
        "/admin/{poolId}/discover": {
            post: {
                tags: ["admin"],
                summary: "Discover eligible Polymarket win markets and create candidates",
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
                                    teamPolymarketId: { type: "string" },
                                    riskPerMatchPct: { type: "number", example: 3 },
                                    liquidityMinUsd: { type: "number", example: 50000 }
                                },
                                required: ["clubName"]
                            }
                        }
                    }
                },
                responses: { 200: { description: "OK" } }
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
                responses: { 200: { description: "TransactionRequest" } }
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
        }
    }
};
function registerSwagger(app) {
    // Client/renderer is done in http.ts. This file only exports spec.
}
