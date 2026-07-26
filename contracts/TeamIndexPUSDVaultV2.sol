// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TeamIndexPUSDVaultV2
/// @notice Polygon pUSD vault whose capital can only be allocated to one Polymarket Deposit Wallet.
/// @dev The Deposit Wallet, controlled by an off-chain EOA signer, is the CLOB maker/funder.
///      This contract never signs orders and deliberately exposes no arbitrary-call primitive.
contract TeamIndexPUSDVaultV2 is
    Initializable,
    ERC4626Upgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_EXTERNAL_ALLOCATION_BPS = 8_000;

    enum RedemptionState {
        NONE,
        PENDING,
        CLAIMABLE,
        CLAIMED,
        CANCELLED
    }

    struct RedemptionRequest {
        address owner;
        address receiver;
        uint256 shares;
        uint256 minAssets;
        uint256 claimableAssets;
        uint64 requestedAt;
        RedemptionState state;
    }

    address public depositWallet;
    address public operator;
    address public valuator;

    uint256 public depositCap;
    uint256 public externalAssetsValue;
    uint256 public externalCapitalOutstanding;
    uint256 public reservedCollateral;
    uint256 public pendingClaimableAssets;

    uint256 public operationalExternalAllocationBps;
    uint256 public minIdleReserveBps;
    uint256 public maxValuationAge;

    uint256 public valuationSequence;
    uint64 public valuedAt;
    bytes32 public valuationSnapshotHash;
    uint256 public accountedCash;

    uint256 public nextRedemptionRequestId;
    mapping(uint256 => RedemptionRequest) public redemptionRequests;
    mapping(bytes32 => uint256) public proposalRemaining;

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event ValuatorUpdated(address indexed previousValuator, address indexed newValuator);
    event DepositCapUpdated(uint256 depositCap);
    event OperationalLimitsUpdated(uint256 externalAllocationBps, uint256 minIdleReserveBps);
    event MaxValuationAgeUpdated(uint256 maxValuationAge);
    event ProposalActivated(bytes32 indexed proposalHash, uint256 allocation);
    event ProposalRevoked(bytes32 indexed proposalHash, uint256 unusedAllocation);
    event CapitalAllocated(bytes32 indexed proposalHash, address indexed depositWallet, uint256 amount);
    event CapitalReturned(address indexed depositWallet, uint256 amount, uint256 outstandingAfter);
    event ExternalValuationRecorded(
        uint256 indexed sequence,
        uint256 externalAssetsValue,
        uint256 reservedCollateral,
        uint64 valuedAt,
        bytes32 indexed snapshotHash
    );
    event RedemptionRequested(
        uint256 indexed requestId,
        address indexed owner,
        address indexed receiver,
        uint256 shares,
        uint256 minAssets
    );
    event RedemptionMadeClaimable(uint256 indexed requestId, uint256 sharesBurned, uint256 assets);
    event RedemptionClaimed(uint256 indexed requestId, address indexed receiver, uint256 assets);
    event RedemptionCancelled(uint256 indexed requestId);

    error Unauthorized();
    error InvalidAddress();
    error InvalidConfiguration();
    error ValuationStale();
    error InvalidValuation();
    error ProposalNotActive();
    error ExternalAllocationExceeded();
    error IdleReserveExceeded();
    error InsufficientIdleCash();
    error InvalidRedemption();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        uint256 depositCap_,
        address initialOwner_,
        address operator_,
        address valuator_,
        address depositWallet_,
        uint256 operationalExternalAllocationBps_,
        uint256 minIdleReserveBps_,
        uint256 maxValuationAge_
    ) external initializer {
        if (
            address(asset_) == address(0) || initialOwner_ == address(0) || operator_ == address(0)
                || valuator_ == address(0) || depositWallet_ == address(0)
        ) revert InvalidAddress();
        _validateLimits(operationalExternalAllocationBps_, minIdleReserveBps_);
        if (maxValuationAge_ == 0) revert InvalidConfiguration();

        __ERC20_init(name_, symbol_);
        __ERC4626_init(asset_);
        __Ownable_init(initialOwner_);
        __Pausable_init();
        __ReentrancyGuard_init();

        depositCap = depositCap_;
        operator = operator_;
        valuator = valuator_;
        depositWallet = depositWallet_;
        operationalExternalAllocationBps = operationalExternalAllocationBps_;
        minIdleReserveBps = minIdleReserveBps_;
        maxValuationAge = maxValuationAge_;
        nextRedemptionRequestId = 1;
        accountedCash = asset_.balanceOf(address(this));
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner()) revert Unauthorized();
        _;
    }

    modifier onlyValuatorOrOwner() {
        if (msg.sender != valuator && msg.sender != owner()) revert Unauthorized();
        _;
    }

    function totalCash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function freeCash() public view returns (uint256) {
        uint256 cash = totalCash();
        return cash > pendingClaimableAssets ? cash - pendingClaimableAssets : 0;
    }

    function totalAssets() public view override returns (uint256) {
        uint256 gross = totalCash() + externalAssetsValue;
        return gross > pendingClaimableAssets ? gross - pendingClaimableAssets : 0;
    }

    function isValuationFresh() public view returns (bool) {
        if (externalAssetsValue == 0 && externalCapitalOutstanding == 0) return true;
        return valuedAt != 0 && block.timestamp <= uint256(valuedAt) + maxValuationAge;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused() || !isValuationFresh()) return 0;
        uint256 parentMax = super.maxDeposit(receiver);
        if (depositCap == 0) return parentMax;
        uint256 assets = totalAssets();
        if (assets >= depositCap) return 0;
        return Math.min(parentMax, depositCap - assets);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (paused() || !isValuationFresh()) return 0;
        uint256 parentMax = super.maxMint(receiver);
        if (depositCap == 0) return parentMax;
        uint256 assets = totalAssets();
        if (assets >= depositCap) return 0;
        return Math.min(parentMax, convertToShares(depositCap - assets));
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        return Math.min(super.maxWithdraw(owner_), freeCash());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        return Math.min(super.maxRedeem(owner_), convertToShares(freeCash()));
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        if (!isValuationFresh()) revert ValuationStale();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        if (!isValuationFresh()) revert ValuationStale();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        if (assets > freeCash()) revert InsufficientIdleCash();
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        if (previewRedeem(shares) > freeCash()) revert InsufficientIdleCash();
        return super.redeem(shares, receiver, owner_);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        accountedCash = totalCash();
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        super._withdraw(caller, receiver, owner_, assets, shares);
        accountedCash = totalCash();
    }

    function activateProposal(bytes32 proposalHash, uint256 allocation) external onlyOwner {
        if (proposalHash == bytes32(0) || allocation == 0) revert InvalidConfiguration();
        proposalRemaining[proposalHash] = allocation;
        emit ProposalActivated(proposalHash, allocation);
    }

    function revokeProposal(bytes32 proposalHash) external onlyOwner {
        uint256 unused = proposalRemaining[proposalHash];
        delete proposalRemaining[proposalHash];
        emit ProposalRevoked(proposalHash, unused);
    }

    function allocateToDepositWallet(uint256 amount, bytes32 proposalHash)
        external
        whenNotPaused
        nonReentrant
        onlyOperatorOrOwner
    {
        if (!isValuationFresh()) revert ValuationStale();
        uint256 remaining = proposalRemaining[proposalHash];
        if (amount == 0 || amount > remaining) revert ProposalNotActive();

        uint256 nav = totalAssets();
        if (
            externalAssetsValue + amount
                > Math.mulDiv(nav, operationalExternalAllocationBps, BPS_DENOMINATOR)
        ) revert ExternalAllocationExceeded();
        if (amount > freeCash()) revert InsufficientIdleCash();
        if (freeCash() - amount < Math.mulDiv(nav, minIdleReserveBps, BPS_DENOMINATOR)) {
            revert IdleReserveExceeded();
        }

        proposalRemaining[proposalHash] = remaining - amount;
        externalAssetsValue += amount;
        externalCapitalOutstanding += amount;
        valuedAt = uint64(block.timestamp);
        IERC20(asset()).safeTransfer(depositWallet, amount);
        accountedCash = totalCash();
        emit CapitalAllocated(proposalHash, depositWallet, amount);
    }

    /// @notice Reconciles pUSD transferred directly back by the registered Deposit Wallet.
    /// @dev Donations are conservatively treated as returned capital; the next valuation snapshot
    ///      remains authoritative for the value still held outside the vault.
    function syncReturnedCapital() external nonReentrant returns (uint256 returnedAmount) {
        uint256 cash = totalCash();
        if (cash <= accountedCash) return 0;
        returnedAmount = cash - accountedCash;
        uint256 principalReduction = Math.min(returnedAmount, externalCapitalOutstanding);
        externalCapitalOutstanding -= principalReduction;
        externalAssetsValue -= Math.min(returnedAmount, externalAssetsValue);
        accountedCash = cash;
        emit CapitalReturned(depositWallet, returnedAmount, externalCapitalOutstanding);
    }

    function recordExternalValuation(
        uint256 sequence,
        uint256 externalAssetsValue_,
        uint256 reservedCollateral_,
        uint64 valuedAt_,
        bytes32 snapshotHash_
    ) external onlyValuatorOrOwner {
        if (
            sequence <= valuationSequence || valuedAt_ == 0 || valuedAt_ > block.timestamp
                || snapshotHash_ == bytes32(0)
        ) revert InvalidValuation();
        valuationSequence = sequence;
        externalAssetsValue = externalAssetsValue_;
        reservedCollateral = reservedCollateral_;
        valuedAt = valuedAt_;
        valuationSnapshotHash = snapshotHash_;
        emit ExternalValuationRecorded(
            sequence, externalAssetsValue_, reservedCollateral_, valuedAt_, snapshotHash_
        );
    }

    function requestRedeem(uint256 shares, address receiver, address owner_, uint256 minAssets)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 requestId)
    {
        if (shares == 0 || receiver == address(0) || owner_ == address(0)) revert InvalidRedemption();
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        _transfer(owner_, address(this), shares);

        requestId = nextRedemptionRequestId++;
        redemptionRequests[requestId] = RedemptionRequest({
            owner: owner_,
            receiver: receiver,
            shares: shares,
            minAssets: minAssets,
            claimableAssets: 0,
            requestedAt: uint64(block.timestamp),
            state: RedemptionState.PENDING
        });
        emit RedemptionRequested(requestId, owner_, receiver, shares, minAssets);
    }

    function cancelRedemption(uint256 requestId) external nonReentrant {
        RedemptionRequest storage request = redemptionRequests[requestId];
        if (request.state != RedemptionState.PENDING || msg.sender != request.owner) revert InvalidRedemption();
        request.state = RedemptionState.CANCELLED;
        _transfer(address(this), request.owner, request.shares);
        emit RedemptionCancelled(requestId);
    }

    function makeRedemptionClaimable(uint256 requestId)
        external
        nonReentrant
        onlyOperatorOrOwner
        returns (uint256 assets)
    {
        RedemptionRequest storage request = redemptionRequests[requestId];
        if (request.state != RedemptionState.PENDING) revert InvalidRedemption();
        assets = previewRedeem(request.shares);
        if (assets < request.minAssets || assets > freeCash()) revert InsufficientIdleCash();

        request.state = RedemptionState.CLAIMABLE;
        request.claimableAssets = assets;
        pendingClaimableAssets += assets;
        _burn(address(this), request.shares);
        emit RedemptionMadeClaimable(requestId, request.shares, assets);
    }

    function claimRedemption(uint256 requestId) external nonReentrant returns (uint256 assets) {
        RedemptionRequest storage request = redemptionRequests[requestId];
        if (request.state != RedemptionState.CLAIMABLE) revert InvalidRedemption();
        request.state = RedemptionState.CLAIMED;
        assets = request.claimableAssets;
        pendingClaimableAssets -= assets;
        IERC20(asset()).safeTransfer(request.receiver, assets);
        accountedCash = totalCash();
        emit RedemptionClaimed(requestId, request.receiver, assets);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function setValuator(address newValuator) external onlyOwner {
        if (newValuator == address(0)) revert InvalidAddress();
        emit ValuatorUpdated(valuator, newValuator);
        valuator = newValuator;
    }

    function setDepositCap(uint256 newDepositCap) external onlyOwner {
        depositCap = newDepositCap;
        emit DepositCapUpdated(newDepositCap);
    }

    function setOperationalLimits(uint256 externalAllocationBps, uint256 idleReserveBps) external onlyOwner {
        _validateLimits(externalAllocationBps, idleReserveBps);
        operationalExternalAllocationBps = externalAllocationBps;
        minIdleReserveBps = idleReserveBps;
        emit OperationalLimitsUpdated(externalAllocationBps, idleReserveBps);
    }

    function setMaxValuationAge(uint256 newMaxValuationAge) external onlyOwner {
        if (newMaxValuationAge == 0) revert InvalidConfiguration();
        maxValuationAge = newMaxValuationAge;
        emit MaxValuationAgeUpdated(newMaxValuationAge);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _validateLimits(uint256 externalAllocationBps, uint256 idleReserveBps) private pure {
        if (
            externalAllocationBps > MAX_EXTERNAL_ALLOCATION_BPS || idleReserveBps > BPS_DENOMINATOR
                || externalAllocationBps + idleReserveBps > BPS_DENOMINATOR
        ) revert InvalidConfiguration();
    }
}
