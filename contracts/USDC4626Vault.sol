// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title USDC4626Vault
/// @notice Per-club ERC4626 vault holding USDC, designed to be deployed as an EIP-1167 clone.
/// @dev Uses the Initializable pattern so that each clone is configured via `initialize()`
///      instead of a constructor. The implementation contract itself is locked via
///      `_disableInitializers()` to prevent direct usage.
contract USDC4626Vault is
    Initializable,
    ERC4626Upgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IERC1271
{
    using SafeERC20 for IERC20;
    using Address for address;

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Basis-point denominator used for fee math (100% = 10_000 bps).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard cap on entry / exit fees (5%) — owner cannot exceed this.
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice ERC-1271 success value: bytes4(keccak256("isValidSignature(bytes32,bytes)")).
    bytes4 public constant ERC1271_MAGICVALUE = 0x1626ba7e;

    /// @notice ERC-1271 failure value.
    bytes4 public constant ERC1271_INVALID = 0xffffffff;

    // ─── Storage ──────────────────────────────────────────────────────────────

    struct OperatorInfo {
        bool authorized;
        uint256 totalAlloc;
        uint256 currentAlloc;
        uint256 txCap;
    }

    uint256 public depositCap;
    uint256 public openPositionsValue;
    /// @notice Signed realized PnL — can be negative if the vault took losses.
    int256 public realizedPnl;

    /// @notice Optional entry fee in basis points (max 500 = 5%).
    uint256 public entryFeeBps;
    /// @notice Optional exit fee in basis points (max 500 = 5%).
    uint256 public exitFeeBps;
    /// @notice Address receiving fees. If zero, no fees are taken even if rates > 0.
    address public feeRecipient;

    /// @notice Authorized to update pool valuation (NAV) without being a full owner.
    /// @dev Lets a hot backend wallet update NAV in the background without holding the
    ///      privileged admin keys. Settable only by `owner`. `address(0)` disables it.
    address public valuator;

    mapping(address => OperatorInfo) private operators;
    address[] private operatorList;

    mapping(address => bool) private whitelistedContracts;
    address[] private whitelistedContractList;

    mapping(address => bool) private trustedStrategies;
    address[] private trustedStrategyList;

    /// @notice EOAs allowed to sign off-chain orders where this vault is the maker.
    mapping(address => bool) private orderSigners;

    /// @notice External trading wallets allowed to receive vault capital for off-chain venues.
    mapping(address => bool) private tradingWallets;
    address[] private tradingWalletList;

    // ─── Events ───────────────────────────────────────────────────────────────

    event OperatorAdded(address indexed operator, uint256 allocation, uint256 transactionCap);
    event OperatorRemoved(address indexed operator);
    event OperatorAllocationUpdated(address indexed operator, uint256 allocation);
    event OperatorTransactionCapUpdated(address indexed operator, uint256 transactionCap);
    event OperatorAllocationReset(address indexed operator);
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
    event PoolValuationUpdated(uint256 openPositionsValue, int256 realizedPnl);
    /// @notice Emitted when an entry/exit fee is taken.
    /// @param payer   Caller for entry fees, receiver for exit fees.
    /// @param treasury Fee recipient at the time of the call.
    /// @param grossAssets Total assets involved in the operation.
    /// @param feeAssets   Fee portion taken.
    /// @param netAssets   grossAssets - feeAssets.
    event VaultFeeCharged(
        address indexed payer,
        address indexed treasury,
        uint256 grossAssets,
        uint256 feeAssets,
        uint256 netAssets
    );
    event FeeConfigUpdated(uint256 entryFeeBps, uint256 exitFeeBps, address feeRecipient);
    event DepositCapUpdated(uint256 newCap);
    event ValuatorUpdated(address indexed oldValuator, address indexed newValuator);
    event OrderSignerUpdated(address indexed signer, bool allowed);
    event TradingWalletUpdated(address indexed wallet, bool allowed);
    event TradingWalletFunded(
        address indexed operator,
        address indexed wallet,
        address indexed asset,
        uint256 amount
    );

    // ─── Construction / Initialization ────────────────────────────────────────

    /// @dev Locks the implementation contract — only clones can be initialized.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize a freshly-cloned vault. Can only be called once.
    /// @param asset_ The underlying ERC20 (USDC).
    /// @param name_ ERC20 name of the share token.
    /// @param symbol_ ERC20 symbol of the share token.
    /// @param depositCap_ Max total assets the vault accepts (0 = unlimited).
    /// @param initialOwner_ Address granted ownership of the vault.
    /// @param initialValuator_ Address allowed to update NAV via `setPoolValuation`. Zero disables.
    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        uint256 depositCap_,
        address initialOwner_,
        address initialValuator_
    ) external initializer {
        require(address(asset_) != address(0), "Vault: zero asset");
        require(initialOwner_ != address(0), "Vault: zero owner");

        __ERC20_init(name_, symbol_);
        __ERC4626_init(IERC20(address(asset_)));
        __Ownable_init(initialOwner_);
        __Pausable_init();
        __ReentrancyGuard_init();

        depositCap = depositCap_;
        valuator = initialValuator_;
        if (initialValuator_ != address(0)) {
            emit ValuatorUpdated(address(0), initialValuator_);
        }
    }

    receive() external payable {}

    // ─── Access ───────────────────────────────────────────────────────────────

    modifier onlyAuthorizedOperatorOrOwner() {
        require(msg.sender == owner() || operators[msg.sender].authorized, "Vault: unauthorized operator");
        _;
    }

    // ─── NAV / accounting ────────────────────────────────────────────────────

    function totalCash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Total assets under management, accounting for open positions and signed PnL.
    /// @dev If realizedPnl is negative and the loss exceeds (cash + openPositionsValue),
    ///      we return 0 instead of reverting so deposits/withdraws can still preview safely.
    function totalAssets() public view override returns (uint256) {
        int256 gross = int256(totalCash() + openPositionsValue) + realizedPnl;
        return gross > 0 ? uint256(gross) : 0;
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

    // ─── Fees (OZ ERC4626 fee pattern) ────────────────────────────────────────

    function previewDeposit(uint256 assets) public view override returns (uint256) {
        uint256 fee = _feeOnTotal(assets, entryFeeBps);
        return super.previewDeposit(assets - fee);
    }

    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 assets = super.previewMint(shares);
        return assets + _feeOnRaw(assets, entryFeeBps);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        uint256 fee = _feeOnRaw(assets, exitFeeBps);
        return super.previewWithdraw(assets + fee);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 assets = super.previewRedeem(shares);
        return assets - _feeOnTotal(assets, exitFeeBps);
    }

    function _feeOnRaw(uint256 assets, uint256 feeBps) private pure returns (uint256) {
        if (feeBps == 0) return 0;
        return Math.mulDiv(assets, feeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
    }

    function _feeOnTotal(uint256 assets, uint256 feeBps) private pure returns (uint256) {
        if (feeBps == 0) return 0;
        return Math.mulDiv(assets, feeBps, feeBps + BPS_DENOMINATOR, Math.Rounding.Ceil);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        uint256 fee = _feeOnTotal(assets, entryFeeBps);
        address recipient = feeRecipient;

        // Pull full `assets` from caller into the vault first…
        SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(this), assets);

        // …then forward the fee out (if any) so the vault's effective deposit is `assets - fee`.
        if (fee > 0 && recipient != address(0)) {
            SafeERC20.safeTransfer(IERC20(asset()), recipient, fee);
            emit VaultFeeCharged(caller, recipient, assets, fee, assets - fee);
        }

        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner_,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (caller != owner_) {
            _spendAllowance(owner_, caller, shares);
        }

        _burn(owner_, shares);

        uint256 fee = _feeOnRaw(assets, exitFeeBps);
        address recipient = feeRecipient;

        if (fee > 0 && recipient != address(0)) {
            SafeERC20.safeTransfer(IERC20(asset()), recipient, fee);
            emit VaultFeeCharged(receiver, recipient, assets + fee, fee, assets);
        }
        SafeERC20.safeTransfer(IERC20(asset()), receiver, assets);

        emit Withdraw(caller, receiver, owner_, assets, shares);
    }

    // ─── Public ERC4626 entry points (with pause + reentrancy guards) ─────────

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

    // ─── ERC-1271 order signing ───────────────────────────────────────────────

    /// @notice Allows or revokes an EOA signer for ERC-1271 order validation.
    /// @dev Signers can create off-chain orders where `maker` and `signer` are this vault.
    function setOrderSigner(address signer, bool allowed) external onlyOwner {
        require(signer != address(0), "Vault: zero signer");
        orderSigners[signer] = allowed;
        emit OrderSignerUpdated(signer, allowed);
    }

    function isOrderSigner(address signer) external view returns (bool) {
        return orderSigners[signer];
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(hash, signature);
        if (error == ECDSA.RecoverError.NoError && orderSigners[recovered]) {
            return ERC1271_MAGICVALUE;
        }
        return ERC1271_INVALID;
    }

    // ─── External trading wallets ────────────────────────────────────────────

    /// @notice Allows or revokes an external venue wallet that may receive vault capital.
    /// @dev Used for Limitless server wallets: the vault remains the treasury, while the
    ///      linked trading wallet holds venue collateral and positions.
    function setTradingWallet(address wallet, bool allowed) external onlyOwner {
        require(wallet != address(0), "Vault: zero trading wallet");
        if (allowed && !tradingWallets[wallet]) {
            tradingWalletList.push(wallet);
        } else if (!allowed && tradingWallets[wallet]) {
            _removeAddress(tradingWalletList, wallet);
        }
        tradingWallets[wallet] = allowed;
        emit TradingWalletUpdated(wallet, allowed);
    }

    function isTradingWallet(address wallet) external view returns (bool) {
        return tradingWallets[wallet];
    }

    function getTradingWallets() external view returns (address[] memory) {
        return tradingWalletList;
    }

    /// @notice Sends underlying asset from the vault to a registered trading wallet.
    /// @dev `assetAmount` allocation accounting is enforced for operators just like
    ///      `executeWhitelistedCall`, but the recipient must be explicitly linked on-chain.
    function fundTradingWallet(address wallet, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        onlyAuthorizedOperatorOrOwner
    {
        require(tradingWallets[wallet], "Vault: trading wallet not linked");

        if (msg.sender != owner() && amount > 0) {
            OperatorInfo storage info = operators[msg.sender];
            if (info.txCap > 0) require(amount <= info.txCap, "Vault: tx cap exceeded");
            if (info.totalAlloc > 0) require(info.currentAlloc + amount <= info.totalAlloc, "Vault: allocation exceeded");
            info.currentAlloc += amount;
        }

        SafeERC20.safeTransfer(IERC20(asset()), wallet, amount);
        emit TradingWalletFunded(msg.sender, wallet, asset(), amount);
    }

    // ─── Operator management ──────────────────────────────────────────────────

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

    /// @notice Resets an operator's `currentAlloc` back to zero so they can keep
    ///         executing whitelisted calls without losing their seat.
    /// @dev Intended to be called when positions are closed and capital is returned to the vault,
    ///      or at the start of a new allocation period. Without this, an operator that exhausts
    ///      their `totalAlloc` is permanently blocked.
    function resetOperatorAllocation(address operator) external onlyOwner {
        require(operators[operator].authorized, "Vault: operator missing");
        operators[operator].currentAlloc = 0;
        emit OperatorAllocationReset(operator);
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

    // ─── Whitelist management ─────────────────────────────────────────────────

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

    // ─── Admin ────────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setDepositCap(uint256 newDepositCap) external onlyOwner {
        depositCap = newDepositCap;
        emit DepositCapUpdated(newDepositCap);
    }

    /// @notice Updates pool valuation. Callable by `owner` OR the dedicated `valuator` role
    ///         so a hot backend wallet can refresh NAV without holding owner powers.
    /// @dev `newRealizedPnl` is signed so losses are representable.
    function setPoolValuation(uint256 newOpenPositionsValue, int256 newRealizedPnl) external {
        require(msg.sender == owner() || (valuator != address(0) && msg.sender == valuator), "Vault: not valuator");
        openPositionsValue = newOpenPositionsValue;
        realizedPnl = newRealizedPnl;
        emit PoolValuationUpdated(newOpenPositionsValue, newRealizedPnl);
    }

    /// @notice Updates the valuator address. Only owner can rotate this role.
    function setValuator(address newValuator) external onlyOwner {
        address old = valuator;
        valuator = newValuator;
        emit ValuatorUpdated(old, newValuator);
    }

    /// @notice Configure fees. Both rates are capped at MAX_FEE_BPS (5%).
    function setFeeConfig(uint256 newEntryFeeBps, uint256 newExitFeeBps, address newFeeRecipient) external onlyOwner {
        require(newEntryFeeBps <= MAX_FEE_BPS, "Vault: entry fee too high");
        require(newExitFeeBps <= MAX_FEE_BPS, "Vault: exit fee too high");
        if (newEntryFeeBps > 0 || newExitFeeBps > 0) {
            require(newFeeRecipient != address(0), "Vault: fee recipient required");
        }
        entryFeeBps = newEntryFeeBps;
        exitFeeBps = newExitFeeBps;
        feeRecipient = newFeeRecipient;
        emit FeeConfigUpdated(newEntryFeeBps, newExitFeeBps, newFeeRecipient);
    }

    // ─── Operator-initiated external calls ────────────────────────────────────

    /// @notice Executes a call to a whitelisted target, enforcing tx-cap and allocation limits.
    /// @dev Uses Address.functionCallWithValue for safer call semantics than raw `.call`.
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
        bytes memory result = target.functionCallWithValue(data, value);

        if (minReturn > 0) {
            uint256 cashAfter = totalCash();
            require(cashAfter + assetAmount >= cashBefore + minReturn, "Vault: min return not met");
        }

        emit WhitelistedCallExecuted(msg.sender, target, value, assetAmount, minReturn, result);
        return result;
    }

    // ─── Rescue ───────────────────────────────────────────────────────────────

    /// @notice Recovers arbitrary ERC20 tokens stuck on the vault.
    /// @dev Cannot be used to rug the underlying asset — `rescueTokens` reverts on `asset()`.
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        require(token != asset(), "Vault: cannot rescue underlying");
        IERC20(token).safeTransfer(owner(), amount);
    }

    function rescueNative(uint256 amount) external onlyOwner {
        (bool ok, ) = owner().call{value: amount}("");
        require(ok, "Vault: native transfer failed");
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

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

    /// @dev Reserved storage slots so future upgrades don't shift storage layout.
    uint256[39] private __gap;
}
