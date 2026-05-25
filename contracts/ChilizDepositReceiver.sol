// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ChilizDepositReceiver is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE_TOKEN = address(0);
    uint256 public nextDepositId = 1;

    event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId);

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {}

    function depositCHZ(bytes32 poolId) external payable nonReentrant {
        require(msg.value > 0, "ChilizReceiver: zero value");
        require(poolId != bytes32(0), "ChilizReceiver: zero poolId");
        emit DepositReceived(nextDepositId++, msg.sender, NATIVE_TOKEN, msg.value, poolId);
    }

    function depositToken(address token, uint256 amount, bytes32 poolId) external nonReentrant {
        require(token != address(0), "ChilizReceiver: zero token");
        require(amount > 0, "ChilizReceiver: zero amount");
        require(poolId != bytes32(0), "ChilizReceiver: zero poolId");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit DepositReceived(nextDepositId++, msg.sender, token, amount, poolId);
    }

    function withdrawFunds(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        require(to != address(0), "ChilizReceiver: zero to");
        if (token == NATIVE_TOKEN) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "ChilizReceiver: native transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
