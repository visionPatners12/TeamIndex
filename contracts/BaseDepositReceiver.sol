// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BaseDepositReceiver
/// @notice Holds USDC deposited on Base while the relayer bridges them to the Polygon vault.
/// @dev Includes a user-side refund window: if the relayer fails to release a deposit
///      within `refundWindow`, the depositor can reclaim their funds themselves.
contract BaseDepositReceiver is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Default refund delay (24h) — owner can change via `setRefundWindow`.
    uint256 public constant DEFAULT_REFUND_WINDOW = 24 hours;
    /// @notice Hard floor on refund window so the owner cannot make refunds impossible.
    uint256 public constant MIN_REFUND_WINDOW = 1 hours;
    /// @notice Hard cap (30 days) so funds can never be locked indefinitely.
    uint256 public constant MAX_REFUND_WINDOW = 30 days;

    struct Deposit {
        address user;
        uint256 amount;
        bytes32 poolId;
        uint64 createdAt;
        bool released;
        bool refunded;
    }

    IERC20 public immutable usdc;
    uint256 public nextDepositId = 1;
    uint256 public refundWindow = DEFAULT_REFUND_WINDOW;
    /// @notice Aggregate USDC currently backing live (un-released, un-refunded) deposits.
    uint256 public totalLockedUsdc;

    mapping(uint256 => Deposit) public deposits;
    mapping(address => bool) public relayers;

    event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId);
    event DepositReleased(uint256 indexed depositId, address indexed to, uint256 amount);
    event DepositRefunded(uint256 indexed depositId, address indexed user, uint256 amount);
    event RelayerUpdated(address indexed relayer, bool authorized);
    event RefundWindowUpdated(uint256 newWindow);

    constructor(IERC20 usdc_, address initialOwner) Ownable(initialOwner) {
        require(address(usdc_) != address(0), "BaseReceiver: zero usdc");
        usdc = usdc_;
    }

    modifier onlyRelayerOrOwner() {
        require(msg.sender == owner() || relayers[msg.sender], "BaseReceiver: unauthorized relayer");
        _;
    }

    function depositUSDC(uint256 amount, bytes32 poolId)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 depositId)
    {
        require(amount > 0, "BaseReceiver: zero amount");
        require(poolId != bytes32(0), "BaseReceiver: zero poolId");

        depositId = nextDepositId++;
        deposits[depositId] = Deposit({
            user: msg.sender,
            amount: amount,
            poolId: poolId,
            createdAt: uint64(block.timestamp),
            released: false,
            refunded: false
        });
        totalLockedUsdc += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit DepositReceived(depositId, msg.sender, address(usdc), amount, poolId);
    }

    function releaseDeposit(uint256 depositId, address to)
        external
        onlyRelayerOrOwner
        nonReentrant
        returns (uint256 amount)
    {
        require(to != address(0), "BaseReceiver: zero to");
        Deposit storage dep = deposits[depositId];
        require(dep.user != address(0), "BaseReceiver: deposit missing");
        require(!dep.released, "BaseReceiver: already released");
        require(!dep.refunded, "BaseReceiver: already refunded");

        dep.released = true;
        amount = dep.amount;
        totalLockedUsdc -= amount;
        usdc.safeTransfer(to, amount);
        emit DepositReleased(depositId, to, amount);
    }

    /// @notice User-initiated refund. Available after `refundWindow` has elapsed since the deposit
    ///         and only if the relayer never released it. Works even when the contract is paused
    ///         so users are never locked out of their own funds.
    function refundDeposit(uint256 depositId) external nonReentrant returns (uint256 amount) {
        Deposit storage dep = deposits[depositId];
        require(dep.user == msg.sender, "BaseReceiver: not deposit owner");
        require(!dep.released, "BaseReceiver: already released");
        require(!dep.refunded, "BaseReceiver: already refunded");
        require(
            block.timestamp >= uint256(dep.createdAt) + refundWindow,
            "BaseReceiver: refund window not elapsed"
        );

        dep.refunded = true;
        amount = dep.amount;
        totalLockedUsdc -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit DepositRefunded(depositId, msg.sender, amount);
    }

    function setRelayer(address relayer, bool authorized) external onlyOwner {
        require(relayer != address(0), "BaseReceiver: zero relayer");
        relayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    function setRefundWindow(uint256 newWindow) external onlyOwner {
        require(newWindow >= MIN_REFUND_WINDOW, "BaseReceiver: window too short");
        require(newWindow <= MAX_REFUND_WINDOW, "BaseReceiver: window too long");
        refundWindow = newWindow;
        emit RefundWindowUpdated(newWindow);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rescue tokens that were sent directly to the contract bypassing `depositUSDC`.
    /// @dev   Cannot drain USDC currently backing live deposits (`totalLockedUsdc` is reserved).
    function rescueTokens(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "BaseReceiver: zero to");
        if (token == address(usdc)) {
            uint256 balance = usdc.balanceOf(address(this));
            uint256 available = balance > totalLockedUsdc ? balance - totalLockedUsdc : 0;
            require(amount <= available, "BaseReceiver: amount exceeds unallocated");
        }
        IERC20(token).safeTransfer(to, amount);
    }
}
