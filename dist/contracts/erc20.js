"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERC20 = void 0;
exports.ERC20 = {
    name: "ERC20",
    abi: [
        "function approve(address spender, uint256 amount) external returns (bool)",
        "function allowance(address owner, address spender) external view returns (uint256)",
        "function balanceOf(address owner) external view returns (uint256)",
        "function decimals() external view returns (uint8)"
    ]
};
