"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVaultContract = getVaultContract;
exports.executeWhitelistedCallViaVault = executeWhitelistedCallViaVault;
exports.ensureVaultErc20Allowance = ensureVaultErc20Allowance;
exports.getErc20Balance = getErc20Balance;
exports.adminSetTradingWallet = adminSetTradingWallet;
exports.isTradingWallet = isTradingWallet;
exports.fundTradingWalletFromVault = fundTradingWalletFromVault;
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
exports.adminSetOrderSigner = adminSetOrderSigner;
exports.isOrderSigner = isOrderSigner;
exports.getAllOperators = getAllOperators;
exports.getOperatorInfo = getOperatorInfo;
exports.getWhitelistedContracts = getWhitelistedContracts;
exports.getTrustedStrategies = getTrustedStrategies;
const ethers_1 = require("ethers");
const usdc4626vault_1 = require("../contracts/usdc4626vault");
const rpc_1 = require("./rpc");
const CLUB_VAULT_FACTORY_ABI = ["function getVaultByClub(bytes32 clubId) view returns (address)"];
const ERC20_ALLOWANCE_APPROVE_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
];
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
        provider = (0, rpc_1.getBaseProvider)(env);
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
async function ensureVaultErc20Allowance(env, pool, params) {
    const provider = (0, rpc_1.getBaseProvider)(env);
    const vault = await getVaultContract(env, provider, pool);
    const vaultAddress = (vault.target ?? vault.address);
    const token = new ethers_1.ethers.Contract(params.token, ERC20_ALLOWANCE_APPROVE_ABI, provider);
    const balance = (await token.balanceOf(vaultAddress));
    if (params.minBalance !== undefined && balance < params.minBalance) {
        throw new Error(`Vault token balance too low for Limitless order: balance=${balance.toString()} required=${params.minBalance.toString()} token=${params.token} vault=${vaultAddress}`);
    }
    const currentAllowance = (await token.allowance(vaultAddress, params.spender));
    if (currentAllowance >= params.minAllowance) {
        return {
            approved: false,
            whitelisted: await isWhitelistedContract(env, pool, params.token).catch(() => false),
            vaultAddress,
            token: params.token,
            spender: params.spender,
            balance: balance.toString(),
            allowance: currentAllowance.toString(),
            required: params.minAllowance.toString(),
        };
    }
    let whitelisted = await isWhitelistedContract(env, pool, params.token).catch(() => false);
    let whitelistTxHash = null;
    if (!whitelisted) {
        const tx = await adminAddWhitelistedContract(env, pool, params.token);
        whitelistTxHash = tx?.hash ?? null;
        if (typeof tx?.wait === "function")
            await tx.wait();
        whitelisted = await isWhitelistedContract(env, pool, params.token);
    }
    const iface = new ethers_1.ethers.Interface(ERC20_ALLOWANCE_APPROVE_ABI);
    const approveAmount = params.approveAmount ?? ethers_1.ethers.MaxUint256;
    const data = iface.encodeFunctionData("approve", [params.spender, approveAmount]);
    const approveTx = await executeWhitelistedCallViaVault(env, pool, {
        target: params.token,
        data,
        value: 0n,
        assetAmount: 0n,
        minReturn: 0n,
        isTrustedRequired: false,
    });
    if (typeof approveTx?.wait === "function")
        await approveTx.wait();
    const allowance = (await token.allowance(vaultAddress, params.spender));
    if (allowance < params.minAllowance) {
        throw new Error(`Vault allowance still too low after approve: ${allowance.toString()} < ${params.minAllowance.toString()}`);
    }
    return {
        approved: true,
        whitelisted,
        vaultAddress,
        token: params.token,
        spender: params.spender,
        balance: balance.toString(),
        required: params.minAllowance.toString(),
        allowance: allowance.toString(),
        approveAmount: approveAmount.toString(),
        whitelistTxHash,
        approveTxHash: approveTx?.hash ?? null,
    };
}
async function getErc20Balance(env, tokenAddress, accountAddress) {
    const provider = (0, rpc_1.getBaseProvider)(env);
    const token = new ethers_1.ethers.Contract(tokenAddress, ERC20_ALLOWANCE_APPROVE_ABI, provider);
    return (await token.balanceOf(accountAddress));
}
async function adminSetTradingWallet(env, pool, params) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.setTradingWallet(params.wallet, params.allowed);
}
async function isTradingWallet(env, pool, wallet) {
    const vault = await getVaultContract(env, undefined, pool);
    if (!("isTradingWallet" in vault))
        throw new Error("Vault missing isTradingWallet");
    return (await vault.isTradingWallet(wallet));
}
async function fundTradingWalletFromVault(env, pool, params) {
    if (params.amount <= 0n) {
        return {
            funded: false,
            wallet: params.wallet,
            amount: params.amount.toString(),
            txHash: null,
        };
    }
    const vault = await getVaultContract(env, undefined, pool);
    if (!("fundTradingWallet" in vault)) {
        throw new Error("Vault does not support linked trading wallets. Redeploy the pool vault with the current USDC4626Vault before server-wallet betting.");
    }
    const tx = await vault.fundTradingWallet(params.wallet, params.amount);
    if (typeof tx?.wait === "function")
        await tx.wait();
    return {
        funded: true,
        wallet: params.wallet,
        amount: params.amount.toString(),
        txHash: tx?.hash ?? null,
    };
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
async function adminSetOrderSigner(env, pool, params) {
    const vault = await getVaultContract(env, undefined, pool);
    return vault.setOrderSigner(params.signer, params.allowed);
}
async function isOrderSigner(env, pool, signer) {
    const vault = await getVaultContract(env, undefined, pool);
    if (!("isOrderSigner" in vault))
        throw new Error("Vault missing isOrderSigner");
    return (await vault.isOrderSigner(signer));
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
