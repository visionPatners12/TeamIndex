"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPolygonProvider = getPolygonProvider;
exports.getPolygonExecutor = getPolygonExecutor;
exports.getPusdVaultV2 = getPusdVaultV2;
exports.activatePoolProposal = activatePoolProposal;
exports.allocatePoolCapital = allocatePoolCapital;
exports.syncPoolReturnedCapital = syncPoolReturnedCapital;
exports.recordPoolExternalValuation = recordPoolExternalValuation;
exports.makePoolRedemptionClaimable = makePoolRedemptionClaimable;
exports.pausePoolVaultV2 = pausePoolVaultV2;
exports.unpausePoolVaultV2 = unpausePoolVaultV2;
exports.deployPoolVaultV2 = deployPoolVaultV2;
const ethers_1 = require("ethers");
const teamIndexPusdVaultV2_1 = require("../contracts/teamIndexPusdVaultV2");
const TEAM_INDEX_V2_FACTORY_ABI = [
    "function createPoolVault(bytes32 poolId,string name,string symbol,uint256 depositCap,address depositWallet,address depositWalletOwner) returns (address)",
    "function getVaultByPool(bytes32 poolId) view returns (address)",
];
function getPolygonProvider(env) {
    if (!env.POLYGON_RPC_URL)
        throw new Error("POLYGON_RPC_URL is required");
    return new ethers_1.JsonRpcProvider(env.POLYGON_RPC_URL, 137, { staticNetwork: true });
}
function getPolygonExecutor(env) {
    if (!env.POLYGON_EXECUTOR_PRIVATE_KEY)
        throw new Error("POLYGON_EXECUTOR_PRIVATE_KEY is required");
    return new ethers_1.Wallet(env.POLYGON_EXECUTOR_PRIVATE_KEY, getPolygonProvider(env));
}
function getPusdVaultV2(env, vaultAddress, write = false) {
    if (!(0, ethers_1.isAddress)(vaultAddress))
        throw new Error(`Invalid TeamIndex V2 vault address: ${vaultAddress}`);
    return new ethers_1.Contract(vaultAddress, teamIndexPusdVaultV2_1.TEAM_INDEX_PUSD_VAULT_V2_ABI, write ? getPolygonExecutor(env) : getPolygonProvider(env));
}
async function waitHash(txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1)
        throw new Error("Polygon vault transaction failed");
    return receipt.hash;
}
async function activatePoolProposal(env, vaultAddress, proposalHash, allocationBaseUnits) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).activateProposal(proposalHash, allocationBaseUnits));
}
async function allocatePoolCapital(env, vaultAddress, proposalHash, amountBaseUnits) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).allocateToDepositWallet(amountBaseUnits, proposalHash));
}
async function syncPoolReturnedCapital(env, vaultAddress) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).syncReturnedCapital());
}
async function recordPoolExternalValuation(env, vaultAddress, params) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).recordExternalValuation(params.sequence, params.externalAssetsBaseUnits, params.reservedCollateralBaseUnits, params.valuedAt, params.snapshotHash));
}
async function makePoolRedemptionClaimable(env, vaultAddress, requestId) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).makeRedemptionClaimable(requestId));
}
async function pausePoolVaultV2(env, vaultAddress) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).pause());
}
async function unpausePoolVaultV2(env, vaultAddress) {
    return waitHash(getPusdVaultV2(env, vaultAddress, true).unpause());
}
async function deployPoolVaultV2(env, params) {
    if (!env.TEAM_INDEX_V2_FACTORY_ADDRESS || !(0, ethers_1.isAddress)(env.TEAM_INDEX_V2_FACTORY_ADDRESS)) {
        throw new Error("TEAM_INDEX_V2_FACTORY_ADDRESS is required to deploy a pool vault");
    }
    const factory = new ethers_1.Contract(env.TEAM_INDEX_V2_FACTORY_ADDRESS, TEAM_INDEX_V2_FACTORY_ABI, getPolygonExecutor(env));
    const poolIdHash = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(`team-index:${params.poolId}`));
    const existing = (await factory.getVaultByPool(poolIdHash));
    if (existing !== "0x0000000000000000000000000000000000000000") {
        return { vaultAddress: existing, poolIdHash, created: false, txHash: null };
    }
    const tx = await factory.createPoolVault(poolIdHash, `TeamIndex ${params.clubName}`, `ti${params.symbol}`.slice(0, 11), params.depositCapBaseUnits, params.depositWalletAddress, params.depositWalletOwner);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1)
        throw new Error("TeamIndex V2 vault deployment failed");
    const vaultAddress = (await factory.getVaultByPool(poolIdHash));
    if (!(0, ethers_1.isAddress)(vaultAddress) || vaultAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("TeamIndex V2 factory did not register the new vault");
    }
    return { vaultAddress, poolIdHash, created: true, txHash: receipt.hash };
}
