"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHILIZ_DEPOSIT_RECEIVER = void 0;
exports.CHILIZ_DEPOSIT_RECEIVER = {
    name: "ChilizDepositReceiver",
    abi: [
        "function depositCHZ(bytes32 poolId) external payable",
        "function depositToken(address token, uint256 amount, bytes32 poolId) external",
        "function withdrawFunds(address token, uint256 amount, address to) external",
        "function nextDepositId() external view returns (uint256)",
        "event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId)"
    ]
};
