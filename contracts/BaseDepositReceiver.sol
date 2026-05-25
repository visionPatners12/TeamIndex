// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract BaseDepositReceiver is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Deposit {
        address user;
        uint256 amount;
        bytes32 poolId;
        bool released;
    }

    IERC20 public immutable usdc;
    uint256 public nextDepositId = 1;

    mapping(uint256 => Deposit) public deposits;
    mapping(address => bool) public relayers;

    event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId);
    event DepositReleased(uint256 indexed depositId, address indexed to, uint256 amount);
    event RelayerUpdated(address indexed relayer, bool authorized);

    constructor(IERC20 usdc_, address initialOwner) Ownable(initialOwner) {
        require(address(usdc_) != address(0), "BaseReceiver: zero usdc");
        usdc = usdc_;
    }

    modifier onlyRelayerOrOwner() {
        require(msg.sender == owner() || relayers[msg.sender], "BaseReceiver: unauthorized relayer");
        _;
    }

    function depositUSDC(uint256 amount, bytes32 poolId) external whenNotPaused nonReentrant returns (uint256 depositId) {
        require(amount > 0, "BaseReceiver: zero amount");
        require(poolId != bytes32(0), "BaseReceiver: zero poolId");

        depositId = nextDepositId++;
        deposits[depositId] = Deposit(msg.sender, amount, poolId, false);
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

        dep.released = true;
        amount = dep.amount;
        usdc.safeTransfer(to, amount);
        emit DepositReleased(depositId, to, amount);
    }

    function setRelayer(address relayer, bool authorized) external onlyOwner {
        require(relayer != address(0), "BaseReceiver: zero relayer");
        relayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueTokens(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "BaseReceiver: zero to");
        IERC20(token).safeTransfer(to, amount);
    }
}
