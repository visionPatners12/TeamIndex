// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TeamIndexRegistryV2} from "./TeamIndexRegistryV2.sol";

interface IERC4626Deposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

/// @title TeamIndexDepositEscrowV2
/// @notice Fallback when the hosted relayer refuses an arbitrary Deposit-Wallet-to-vault call.
/// @dev Users only transfer pUSD to this contract. The backend verifies that transfer off-chain,
///      then the operator atomically deposits it into a registered TeamIndex vault for the user.
contract TeamIndexDepositEscrowV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable pUSD;
    TeamIndexRegistryV2 public immutable registry;
    address public operator;
    mapping(bytes32 => bool) public settledIntents;

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event EscrowDepositSettled(
        bytes32 indexed intentId,
        address indexed vault,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );

    error Unauthorized();
    error InvalidAddress();
    error InvalidIntent();
    error UnknownVault();

    constructor(IERC20 pUSD_, TeamIndexRegistryV2 registry_, address initialOwner, address operator_)
        Ownable(initialOwner)
    {
        if (address(pUSD_) == address(0) || address(registry_) == address(0) || operator_ == address(0)) {
            revert InvalidAddress();
        }
        pUSD = pUSD_;
        registry = registry_;
        operator = operator_;
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner()) revert Unauthorized();
        _;
    }

    function settle(bytes32 intentId, address vault, address receiver, uint256 assets)
        external
        nonReentrant
        onlyOperatorOrOwner
        returns (uint256 shares)
    {
        if (intentId == bytes32(0) || receiver == address(0) || assets == 0 || settledIntents[intentId]) {
            revert InvalidIntent();
        }
        bytes32 poolId = registry.poolByVault(vault);
        (address registeredVault,,, bool active) = registry.pools(poolId);
        if (registeredVault != vault || !active) revert UnknownVault();

        settledIntents[intentId] = true;
        pUSD.forceApprove(vault, assets);
        shares = IERC4626Deposit(vault).deposit(assets, receiver);
        pUSD.forceApprove(vault, 0);
        emit EscrowDepositSettled(intentId, vault, receiver, assets, shares);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }
}
