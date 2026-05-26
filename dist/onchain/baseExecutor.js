"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBaseProvider = getBaseProvider;
exports.getBaseSigner = getBaseSigner;
exports.getBaseDepositReceiverContract = getBaseDepositReceiverContract;
exports.getBaseWrappedShareContract = getBaseWrappedShareContract;
exports.mintBaseWrappedShares = mintBaseWrappedShares;
const ethers_1 = require("ethers");
const baseDepositReceiver_1 = require("../contracts/baseDepositReceiver");
const wrappedVaultShare_1 = require("../contracts/wrappedVaultShare");
function getBaseProvider(env) {
    if (!env.BASE_RPC_URL)
        throw new Error("BASE_RPC_URL not set");
    return new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL, undefined, { batchMaxCount: 1 });
}
function getBaseSigner(env) {
    if (!env.BASE_EXECUTOR_PRIVATE_KEY)
        throw new Error("BASE_EXECUTOR_PRIVATE_KEY not set");
    const provider = getBaseProvider(env);
    return new ethers_1.ethers.Wallet(env.BASE_EXECUTOR_PRIVATE_KEY, provider);
}
function getBaseDepositReceiverContract(env, signerOrProvider) {
    if (!env.BASE_DEPOSIT_RECEIVER_ADDRESS)
        throw new Error("BASE_DEPOSIT_RECEIVER_ADDRESS not set");
    const sp = signerOrProvider ?? getBaseProvider(env);
    return new ethers_1.ethers.Contract(env.BASE_DEPOSIT_RECEIVER_ADDRESS, baseDepositReceiver_1.BASE_DEPOSIT_RECEIVER.abi, sp);
}
function getBaseWrappedShareContract(env, signerOrProvider) {
    if (!env.BASE_WRAPPED_SHARE_ADDRESS)
        throw new Error("BASE_WRAPPED_SHARE_ADDRESS not set");
    const sp = signerOrProvider ?? getBaseSigner(env);
    return new ethers_1.ethers.Contract(env.BASE_WRAPPED_SHARE_ADDRESS, wrappedVaultShare_1.WRAPPED_VAULT_SHARE.abi, sp);
}
async function mintBaseWrappedShares(env, to, amount, polygonDepositId) {
    const contract = getBaseWrappedShareContract(env);
    return contract.mint(to, amount, polygonDepositId);
}
