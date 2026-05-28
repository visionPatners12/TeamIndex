// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ChilizDepositReceiver
/// @notice Accepts CHZ and Chiliz-side ERC20 deposits, holding them while a relayer bridges to Polygon.
/// @dev Mirrors `BaseDepositReceiver` semantics: storage-backed deposits + user-side refund window.
contract ChilizDepositReceiver is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE_TOKEN = address(0);

    uint256 public constant DEFAULT_REFUND_WINDOW = 24 hours;
    uint256 public constant MIN_REFUND_WINDOW = 1 hours;
    uint256 public constant MAX_REFUND_WINDOW = 30 days;

    struct Deposit {
        address user;
        address token; // address(0) for native CHZ
        uint256 amount;
        bytes32 poolId;
        uint64 createdAt;
        bool released;
        bool refunded;
    }

    uint256 public nextDepositId = 1;
    uint256 public refundWindow = DEFAULT_REFUND_WINDOW;

    /// @notice Per-token tally of funds backing live deposits, to keep `withdrawFunds` honest.
    mapping(address => uint256) public lockedBalance;

    mapping(uint256 => Deposit) public deposits;
    mapping(address => bool) public relayers;

    event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId);
    event DepositReleased(uint256 indexed depositId, address indexed to, address token, uint256 amount);
    event DepositRefunded(uint256 indexed depositId, address indexed user, address token, uint256 amount);
    event RelayerUpdated(address indexed relayer, bool authorized);
    event RefundWindowUpdated(uint256 newWindow);

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {}

    modifier onlyRelayerOrOwner() {
        require(msg.sender == owner() || relayers[msg.sender], "ChilizReceiver: unauthorized relayer");
        _;
    }

    // ─── User deposits ────────────────────────────────────────────────────────

    function depositCHZ(bytes32 poolId)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 depositId)
    {
        require(msg.value > 0, "ChilizReceiver: zero value");
        require(poolId != bytes32(0), "ChilizReceiver: zero poolId");

        depositId = nextDepositId++;
        deposits[depositId] = Deposit({
            user: msg.sender,
            token: NATIVE_TOKEN,
            amount: msg.value,
            poolId: poolId,
            createdAt: uint64(block.timestamp),
            released: false,
            refunded: false
        });
        lockedBalance[NATIVE_TOKEN] += msg.value;

        emit DepositReceived(depositId, msg.sender, NATIVE_TOKEN, msg.value, poolId);
    }

    function depositToken(address token, uint256 amount, bytes32 poolId)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 depositId)
    {
        require(token != address(0), "ChilizReceiver: zero token");
        require(amount > 0, "ChilizReceiver: zero amount");
        require(poolId != bytes32(0), "ChilizReceiver: zero poolId");

        depositId = nextDepositId++;
        deposits[depositId] = Deposit({
            user: msg.sender,
            token: token,
            amount: amount,
            poolId: poolId,
            createdAt: uint64(block.timestamp),
            released: false,
            refunded: false
        });
        lockedBalance[token] += amount;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit DepositReceived(depositId, msg.sender, token, amount, poolId);
    }

    // ─── Relayer release ──────────────────────────────────────────────────────

    function releaseDeposit(uint256 depositId, address to)
        external
        onlyRelayerOrOwner
        nonReentrant
        returns (uint256 amount, address token)
    {
        require(to != address(0), "ChilizReceiver: zero to");
        Deposit storage dep = deposits[depositId];
        require(dep.user != address(0), "ChilizReceiver: deposit missing");
        require(!dep.released, "ChilizReceiver: already released");
        require(!dep.refunded, "ChilizReceiver: already refunded");

        dep.released = true;
        amount = dep.amount;
        token = dep.token;
        lockedBalance[token] -= amount;

        if (token == NATIVE_TOKEN) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "ChilizReceiver: native transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit DepositReleased(depositId, to, token, amount);
    }

    // ─── User refund (escape hatch) ───────────────────────────────────────────

    /// @notice Allows the depositor to reclaim funds if the relayer never released them
    ///         within `refundWindow`. Works even when paused.
    function refundDeposit(uint256 depositId)
        external
        nonReentrant
        returns (uint256 amount, address token)
    {
        Deposit storage dep = deposits[depositId];
        require(dep.user == msg.sender, "ChilizReceiver: not deposit owner");
        require(!dep.released, "ChilizReceiver: already released");
        require(!dep.refunded, "ChilizReceiver: already refunded");
        require(
            block.timestamp >= uint256(dep.createdAt) + refundWindow,
            "ChilizReceiver: refund window not elapsed"
        );

        dep.refunded = true;
        amount = dep.amount;
        token = dep.token;
        lockedBalance[token] -= amount;

        if (token == NATIVE_TOKEN) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            require(ok, "ChilizReceiver: native transfer failed");
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        emit DepositRefunded(depositId, msg.sender, token, amount);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setRelayer(address relayer, bool authorized) external onlyOwner {
        require(relayer != address(0), "ChilizReceiver: zero relayer");
        relayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    function setRefundWindow(uint256 newWindow) external onlyOwner {
        require(newWindow >= MIN_REFUND_WINDOW, "ChilizReceiver: window too short");
        require(newWindow <= MAX_REFUND_WINDOW, "ChilizReceiver: window too long");
        refundWindow = newWindow;
        emit RefundWindowUpdated(newWindow);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraws funds that are NOT backing a live deposit (mis-sent tokens / native).
    /// @dev   Reverts if `amount` would dip into the locked balance reserved for users.
    function withdrawFunds(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        require(to != address(0), "ChilizReceiver: zero to");
        uint256 locked = lockedBalance[token];

        if (token == NATIVE_TOKEN) {
            uint256 available = address(this).balance > locked ? address(this).balance - locked : 0;
            require(amount <= available, "ChilizReceiver: amount exceeds unallocated");
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "ChilizReceiver: native transfer failed");
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 available = balance > locked ? balance - locked : 0;
            require(amount <= available, "ChilizReceiver: amount exceeds unallocated");
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
