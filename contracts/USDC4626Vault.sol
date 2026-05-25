// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract USDC4626Vault is ERC4626, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct OperatorInfo {
        bool authorized;
        uint256 totalAlloc;
        uint256 currentAlloc;
        uint256 txCap;
    }

    uint256 public depositCap;
    uint256 public openPositionsValue;
    uint256 public realizedPnl;

    mapping(address => OperatorInfo) private operators;
    address[] private operatorList;

    mapping(address => bool) private whitelistedContracts;
    address[] private whitelistedContractList;

    mapping(address => bool) private trustedStrategies;
    address[] private trustedStrategyList;

    event OperatorAdded(address indexed operator, uint256 allocation, uint256 transactionCap);
    event OperatorRemoved(address indexed operator);
    event OperatorAllocationUpdated(address indexed operator, uint256 allocation);
    event OperatorTransactionCapUpdated(address indexed operator, uint256 transactionCap);
    event WhitelistedContractAdded(address indexed contractAddress);
    event WhitelistedContractRemoved(address indexed contractAddress);
    event TrustedStrategyAdded(address indexed strategy);
    event TrustedStrategyRemoved(address indexed strategy);
    event WhitelistedCallExecuted(
        address indexed operator,
        address indexed target,
        uint256 value,
        uint256 assetAmount,
        uint256 minReturn,
        bytes result
    );
    event PoolValuationUpdated(uint256 openPositionsValue, uint256 realizedPnl);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        uint256 depositCap_,
        address initialOwner
    ) ERC4626(asset_) ERC20(name_, symbol_) Ownable(initialOwner) {
        depositCap = depositCap_;
    }

    receive() external payable {}

    modifier onlyAuthorizedOperatorOrOwner() {
        require(msg.sender == owner() || operators[msg.sender].authorized, "Vault: unauthorized operator");
        _;
    }

    function totalCash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function totalAssets() public view override returns (uint256) {
        return totalCash() + openPositionsValue + realizedPnl;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 parentMax = super.maxDeposit(receiver);
        if (depositCap == 0) return parentMax;
        uint256 assets = totalAssets();
        if (assets >= depositCap) return 0;
        uint256 remaining = depositCap - assets;
        return remaining < parentMax ? remaining : parentMax;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 parentMax = super.maxMint(receiver);
        if (depositCap == 0) return parentMax;
        uint256 assets = totalAssets();
        if (assets >= depositCap) return 0;
        uint256 remaining = depositCap - assets;
        uint256 shares = convertToShares(remaining);
        return shares < parentMax ? shares : parentMax;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        return super.maxWithdraw(owner_);
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        return super.maxRedeem(owner_);
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    function addAuthorizedOperator(address operator, uint256 allocation, uint256 transactionCap) external onlyOwner {
        require(operator != address(0), "Vault: zero operator");
        if (!operators[operator].authorized) operatorList.push(operator);
        operators[operator] = OperatorInfo(true, allocation, operators[operator].currentAlloc, transactionCap);
        emit OperatorAdded(operator, allocation, transactionCap);
    }

    function removeAuthorizedOperator(address operator) external onlyOwner {
        require(operators[operator].authorized, "Vault: operator missing");
        delete operators[operator];
        _removeAddress(operatorList, operator);
        emit OperatorRemoved(operator);
    }

    function setOperatorAllocation(address operator, uint256 newAllocation) external onlyOwner {
        require(operators[operator].authorized, "Vault: operator missing");
        operators[operator].totalAlloc = newAllocation;
        emit OperatorAllocationUpdated(operator, newAllocation);
    }

    function setOperatorTransactionCap(address operator, uint256 newTxCap) external onlyOwner {
        require(operators[operator].authorized, "Vault: operator missing");
        operators[operator].txCap = newTxCap;
        emit OperatorTransactionCapUpdated(operator, newTxCap);
    }

    function getAllOperators() external view returns (address[] memory) {
        return operatorList;
    }

    function getOperatorInfo(address operator)
        external
        view
        returns (bool authorized, uint256 totalAlloc, uint256 currentAlloc, uint256 txCap)
    {
        OperatorInfo memory info = operators[operator];
        return (info.authorized, info.totalAlloc, info.currentAlloc, info.txCap);
    }

    function addWhitelistedContract(address contractAddress) external onlyOwner {
        require(contractAddress != address(0), "Vault: zero contract");
        if (!whitelistedContracts[contractAddress]) {
            whitelistedContracts[contractAddress] = true;
            whitelistedContractList.push(contractAddress);
            emit WhitelistedContractAdded(contractAddress);
        }
    }

    function removeWhitelistedContract(address contractAddress) external onlyOwner {
        require(whitelistedContracts[contractAddress], "Vault: contract missing");
        whitelistedContracts[contractAddress] = false;
        _removeAddress(whitelistedContractList, contractAddress);
        emit WhitelistedContractRemoved(contractAddress);
    }

    function isWhitelistedContract(address contractAddress) external view returns (bool) {
        return whitelistedContracts[contractAddress];
    }

    function getWhitelistedContracts() external view returns (address[] memory) {
        return whitelistedContractList;
    }

    function addTrustedStrategy(address strategy) external onlyOwner {
        require(strategy != address(0), "Vault: zero strategy");
        if (!trustedStrategies[strategy]) {
            trustedStrategies[strategy] = true;
            trustedStrategyList.push(strategy);
            emit TrustedStrategyAdded(strategy);
        }
    }

    function removeTrustedStrategy(address strategy) external onlyOwner {
        require(trustedStrategies[strategy], "Vault: strategy missing");
        trustedStrategies[strategy] = false;
        _removeAddress(trustedStrategyList, strategy);
        emit TrustedStrategyRemoved(strategy);
    }

    function isTrustedStrategy(address strategy) external view returns (bool) {
        return trustedStrategies[strategy];
    }

    function getTrustedStrategies() external view returns (address[] memory) {
        return trustedStrategyList;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setDepositCap(uint256 newDepositCap) external onlyOwner {
        depositCap = newDepositCap;
    }

    function setPoolValuation(uint256 newOpenPositionsValue, uint256 newRealizedPnl) external onlyOwner {
        openPositionsValue = newOpenPositionsValue;
        realizedPnl = newRealizedPnl;
        emit PoolValuationUpdated(newOpenPositionsValue, newRealizedPnl);
    }

    function executeWhitelistedCall(
        address target,
        bytes calldata data,
        uint256 value,
        uint256 assetAmount,
        uint256 minReturn,
        bool isTrustedRequired
    ) external whenNotPaused nonReentrant onlyAuthorizedOperatorOrOwner returns (bytes memory) {
        require(whitelistedContracts[target], "Vault: target not whitelisted");
        if (isTrustedRequired) require(trustedStrategies[target], "Vault: target not trusted");

        if (msg.sender != owner() && assetAmount > 0) {
            OperatorInfo storage info = operators[msg.sender];
            if (info.txCap > 0) require(assetAmount <= info.txCap, "Vault: tx cap exceeded");
            if (info.totalAlloc > 0) require(info.currentAlloc + assetAmount <= info.totalAlloc, "Vault: allocation exceeded");
            info.currentAlloc += assetAmount;
        }

        uint256 cashBefore = totalCash();
        (bool ok, bytes memory result) = target.call{value: value}(data);
        require(ok, "Vault: target call failed");

        if (minReturn > 0) {
            uint256 cashAfter = totalCash();
            require(cashAfter + assetAmount >= cashBefore + minReturn, "Vault: min return not met");
        }

        emit WhitelistedCallExecuted(msg.sender, target, value, assetAmount, minReturn, result);
        return result;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    function rescueNative(uint256 amount) external onlyOwner {
        (bool ok, ) = owner().call{value: amount}("");
        require(ok, "Vault: native transfer failed");
    }

    function _removeAddress(address[] storage values, address value) private {
        uint256 len = values.length;
        for (uint256 i = 0; i < len; i++) {
            if (values[i] == value) {
                values[i] = values[len - 1];
                values.pop();
                return;
            }
        }
    }
}
