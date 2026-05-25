"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChilizProvider = getChilizProvider;
exports.getChilizSigner = getChilizSigner;
exports.getWrappedShareContract = getWrappedShareContract;
exports.getDepositReceiverContract = getDepositReceiverContract;
exports.mintWrappedShares = mintWrappedShares;
exports.burnWrappedShares = burnWrappedShares;
const ethers_1 = require("ethers");
const wrappedVaultShare_1 = require("../contracts/wrappedVaultShare");
const chilizDepositReceiver_1 = require("../contracts/chilizDepositReceiver");
function getChilizProvider(env) {
    if (!env.CHILIZ_RPC_URL)
        throw new Error("CHILIZ_RPC_URL not set");
    return new ethers_1.ethers.JsonRpcProvider(env.CHILIZ_RPC_URL);
}
function getChilizSigner(env) {
    if (!env.CHILIZ_EXECUTOR_PRIVATE_KEY)
        throw new Error("CHILIZ_EXECUTOR_PRIVATE_KEY not set");
    const provider = getChilizProvider(env);
    return new ethers_1.ethers.Wallet(env.CHILIZ_EXECUTOR_PRIVATE_KEY, provider);
}
function getWrappedShareContract(env, signerOrProvider) {
    if (!env.CHILIZ_WRAPPED_SHARE_ADDRESS)
        throw new Error("CHILIZ_WRAPPED_SHARE_ADDRESS not set");
    const sp = signerOrProvider ?? getChilizSigner(env);
    return new ethers_1.ethers.Contract(env.CHILIZ_WRAPPED_SHARE_ADDRESS, wrappedVaultShare_1.WRAPPED_VAULT_SHARE.abi, sp);
}
function getDepositReceiverContract(env, signerOrProvider) {
    if (!env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS)
        throw new Error("CHILIZ_DEPOSIT_RECEIVER_ADDRESS not set");
    const sp = signerOrProvider ?? getChilizProvider(env);
    return new ethers_1.ethers.Contract(env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS, chilizDepositReceiver_1.CHILIZ_DEPOSIT_RECEIVER.abi, sp);
}
async function mintWrappedShares(env, to, amount, polygonDepositId) {
    const contract = getWrappedShareContract(env);
    const tx = await contract.mint(to, amount, polygonDepositId);
    return tx;
}
async function burnWrappedShares(env, from, amount, redemptionId) {
    const contract = getWrappedShareContract(env);
    const tx = await contract.burn(from, amount, redemptionId);
    return tx;
}
