// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ShareExchange
/// @notice Fixed-price secondary market for club shares settled in USDC.
/// @dev Sellers escrow share tokens in this contract. Buyers pay USDC atomically
///      and receive the purchased shares in the same transaction.
contract ShareExchange is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BPS = 500;

    IERC20 public immutable usdc;

    uint256 public nextOrderId = 1;
    uint256 public feeBps;
    address public feeRecipient;

    mapping(address => bool) public shareTokenEnabled;

    struct SellOrder {
        address seller;
        address shareToken;
        uint256 shareUnit;
        uint256 remainingShares;
        uint256 priceUsdcPerShare;
        bool active;
    }

    mapping(uint256 => SellOrder) public sellOrders;

    event ShareTokenUpdated(address indexed shareToken, bool enabled);
    event FeeConfigUpdated(uint256 feeBps, address feeRecipient);
    event SellOrderCreated(
        uint256 indexed orderId,
        address indexed seller,
        address indexed shareToken,
        uint256 shareAmount,
        uint256 priceUsdcPerShare
    );
    event SellOrderFilled(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 shareAmount,
        uint256 usdcPaid,
        uint256 feePaid
    );
    event SellOrderCancelled(uint256 indexed orderId, address indexed seller, uint256 returnedShares);

    constructor(IERC20 usdc_, address initialOwner, address initialFeeRecipient) Ownable(initialOwner) {
        require(address(usdc_) != address(0), "Exchange: zero USDC");
        require(initialFeeRecipient != address(0), "Exchange: zero fee recipient");
        usdc = usdc_;
        feeRecipient = initialFeeRecipient;
        emit FeeConfigUpdated(0, initialFeeRecipient);
    }

    function setShareTokenEnabled(address shareToken, bool enabled) external onlyOwner {
        require(shareToken != address(0), "Exchange: zero share token");
        shareTokenEnabled[shareToken] = enabled;
        emit ShareTokenUpdated(shareToken, enabled);
    }

    function setFeeConfig(uint256 newFeeBps, address newFeeRecipient) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "Exchange: fee too high");
        require(newFeeRecipient != address(0), "Exchange: zero fee recipient");
        feeBps = newFeeBps;
        feeRecipient = newFeeRecipient;
        emit FeeConfigUpdated(newFeeBps, newFeeRecipient);
    }

    function createSellOrder(address shareToken, uint256 shareAmount, uint256 priceUsdcPerShare)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 orderId)
    {
        require(shareTokenEnabled[shareToken], "Exchange: share token disabled");
        require(shareAmount > 0, "Exchange: zero shares");
        require(priceUsdcPerShare > 0, "Exchange: zero price");

        uint8 decimals = IERC20Metadata(shareToken).decimals();
        require(decimals <= 36, "Exchange: unsupported decimals");
        uint256 shareUnit = 10 ** uint256(decimals);

        orderId = nextOrderId++;
        sellOrders[orderId] = SellOrder({
            seller: msg.sender,
            shareToken: shareToken,
            shareUnit: shareUnit,
            remainingShares: shareAmount,
            priceUsdcPerShare: priceUsdcPerShare,
            active: true
        });

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), shareAmount);

        emit SellOrderCreated(orderId, msg.sender, shareToken, shareAmount, priceUsdcPerShare);
    }

    function buy(uint256 orderId, uint256 shareAmount) external whenNotPaused nonReentrant {
        SellOrder storage order = sellOrders[orderId];
        require(order.active, "Exchange: inactive order");
        require(shareAmount > 0, "Exchange: zero shares");
        require(shareAmount <= order.remainingShares, "Exchange: too many shares");

        uint256 usdcAmount = quoteOrder(orderId, shareAmount);
        uint256 fee = Math.mulDiv(usdcAmount, feeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        uint256 sellerProceeds = usdcAmount - fee;

        order.remainingShares -= shareAmount;
        if (order.remainingShares == 0) {
            order.active = false;
        }

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        if (fee > 0) {
            usdc.safeTransfer(feeRecipient, fee);
        }
        usdc.safeTransfer(order.seller, sellerProceeds);
        IERC20(order.shareToken).safeTransfer(msg.sender, shareAmount);

        emit SellOrderFilled(orderId, msg.sender, order.seller, shareAmount, usdcAmount, fee);
    }

    function cancelSellOrder(uint256 orderId) external nonReentrant {
        SellOrder storage order = sellOrders[orderId];
        require(order.active, "Exchange: inactive order");
        require(msg.sender == order.seller || msg.sender == owner(), "Exchange: not authorized");

        uint256 remaining = order.remainingShares;
        order.remainingShares = 0;
        order.active = false;

        IERC20(order.shareToken).safeTransfer(order.seller, remaining);
        emit SellOrderCancelled(orderId, order.seller, remaining);
    }

    function quoteOrder(uint256 orderId, uint256 shareAmount) public view returns (uint256) {
        SellOrder storage order = sellOrders[orderId];
        require(order.seller != address(0), "Exchange: missing order");
        return Math.mulDiv(shareAmount, order.priceUsdcPerShare, order.shareUnit, Math.Rounding.Ceil);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
