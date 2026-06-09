"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVaultContract = getVaultContract;
exports.executeWhitelistedCallViaVault = executeWhitelistedCallViaVault;
exports.adminAddAuthorizedOperator = adminAddAuthorizedOperator;
exports.adminAddWhitelistedContract = adminAddWhitelistedContract;
exports.adminPause = adminPause;
exports.adminUnpause = adminUnpause;
exports.adminRemoveAuthorizedOperator = adminRemoveAuthorizedOperator;
exports.adminSetOperatorAllocation = adminSetOperatorAllocation;
exports.adminSetOperatorTransactionCap = adminSetOperatorTransactionCap;
exports.adminRemoveWhitelistedContract = adminRemoveWhitelistedContract;
exports.isWhitelistedContract = isWhitelistedContract;
exports.adminAddTrustedStrategy = adminAddTrustedStrategy;
exports.adminRemoveTrustedStrategy = adminRemoveTrustedStrategy;
exports.isTrustedStrategy = isTrustedStrategy;
exports.getAllOperators = getAllOperators;
exports.getOperatorInfo = getOperatorInfo;
exports.getWhitelistedContracts = getWhitelistedContracts;
exports.getTrustedStrategies = getTrustedStrategies;
const ethers_1 = require("ethers");
const usdc4626vault_1 = require("../contracts/usdc4626vault");
const CLUB_VAULT_FACTORY_ABI = ["function getVaultByClub(bytes32 clubId) view returns (address)"];
function computeClubId(clubName) {
    // Vault factory uses `bytes32 clubId` -> vault mapping.
    // MVP convention: clubId = keccak256(abi.encodePacked(clubName)).
    return ethers_1.ethers.solidityPackedKeccak256(["string"], [clubName]);
}
async function resolveVaultAddressFromFactory(env, provider, pool) {
    if (!env.CLUB_VAULT_FACTORY_ADDRESS)
        return undefined;
    const factory = new ethers_1.ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, CLUB_VAULT_FACTORY_ABI, provider);
    const clubId = computeClubId(pool.clubName);
    const resolved = (await factory.getVaultByClub(clubId));
    if (!resolved || resolved === ethers_1.ethers.ZeroAddress)
        return undefined;
    return resolved;
}
async function getVaultContract(env, provider, pool) {
    if (!provider) {
        if (!env.BASE_RPC_URL)
            throw new Error("RPC_URL missing");
        provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
    }
    const placeholderAddress = "0x0000000000000000000000000000000000000001";
    // Priority:
    // 1) Explicit stored vault address from DB (`pool.vaultAddress`)
    // 2) env.VAULT_CONTRACT_ADDRESS
    // 3) Resolve via factory (`CLUB_VAULT_FACTORY_ADDRESS`)
    let vaultAddress = pool?.vaultAddress ?? env.VAULT_CONTRACT_ADDRESS;
    if (pool && (!vaultAddress || vaultAddress === placeholderAddress)) {
        const resolved = await resolveVaultAddressFromFactory(env, provider, pool);
        if (resolved)
            vaultAddress = resolved;
    }
    if (!vaultAddress)
        throw new Error("VAULT_CONTRACT_ADDRESS missing");
    if (vaultAddress === "0x0000000000000000000000000000000000000001") {
        throw new Error("VAULT_CONTRACT_ADDRESS is still a placeholder. Set VAULT_CONTRACT_ADDRESS or configure CLUB_VAULT_FACTORY_ADDRESS.");
    }
    const signer = env.BASE_EXECUTOR_PRIVATE_KEY ? new ethers_1.ethers.Wallet(env.BASE_EXECUTOR_PRIVATE_KEY, provider) : undefined;
    return new ethers_1.ethers.Contract(vaultAddress, usdc4626vault_1.USDC4626VAULT.abi, signer ?? provider);
}
async function executeWhitelistedCallViaVault(env, pool, params) {
    const vault = await getVaultContract(env, undefined, pool);
    if (!("executeWhitelistedCall" in vault)) {
        throw new Error("Vault contract missing executeWhitelistedCall");
    }
    // Note: vault contract expects `uint256` args as BigInt compatible.
    const tx = await vault.executeWhitelistedCall(params.target, params.data, params.value, params.assetAmount, params.minReturn, params.isTrustedRequired);
    return tx;
}
async function adminAddAuthorizedOperator(env, pool, params) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.addAuthorizedOperator(params.operator, params.allocation, params.transactionCap);
}
async function adminAddWhitelistedContract(env, pool, contractAddress) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.addWhitelistedContract(contractAddress);
}
async function adminPause(env, pool) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.pause();
}
async function adminUnpause(env, pool) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.unpause();
}
async function adminRemoveAuthorizedOperator(env, pool, operator) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.removeAuthorizedOperator(operator);
}
async function adminSetOperatorAllocation(env, pool, params) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.setOperatorAllocation(params.operator, params.newAllocation);
}
async function adminSetOperatorTransactionCap(env, pool, params) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.setOperatorTransactionCap(params.operator, params.newTxCap);
}
async function adminRemoveWhitelistedContract(env, pool, contractAddress) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.removeWhitelistedContract(contractAddress);
}
async function isWhitelistedContract(env, pool, contractAddress) {
    const vault = await getVaultContract(env, undefined, pool);
    if (!("isWhitelistedContract" in vault))
        throw new Error("Vault missing isWhitelistedContract");
    return (await vault.isWhitelistedContract(contractAddress));
}
async function adminAddTrustedStrategy(env, pool, strategy) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.addTrustedStrategy(strategy);
}
async function adminRemoveTrustedStrategy(env, pool, strategy) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.removeTrustedStrategy(strategy);
}
async function isTrustedStrategy(env, pool, strategy) {
    const vault = await getVaultContract(env, undefined, pool);
    if (!("isTrustedStrategy" in vault))
        throw new Error("Vault missing isTrustedStrategy");
    return (await vault.isTrustedStrategy(strategy));
}
async function getAllOperators(env, pool) {
    const vault = await getVaultContract(env, undefined, pool);
    return (await vault.getAllOperators());
}
async function getOperatorInfo(env, pool, operator) {
    const vault = await getVaultContract(env, undefined, pool);
    return (await vault.getOperatorInfo(operator));
}
async function getWhitelistedContracts(env, pool) {
    const vault = await getVaultContract(env, undefined, pool);
    return (await vault.getWhitelistedContracts());
}
async function getTrustedStrategies(env, pool) {
    const vault = await getVaultContract(env, undefined, pool);
    return (await vault.getTrustedStrategies());
}
