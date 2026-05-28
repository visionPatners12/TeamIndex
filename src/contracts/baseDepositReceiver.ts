export const BASE_DEPOSIT_RECEIVER = {
  name: "BaseDepositReceiver",
  abi: [
    "function depositUSDC(uint256 amount, bytes32 poolId) external returns (uint256)",
    "function releaseDeposit(uint256 depositId, address to) external returns (uint256)",
    "function refundDeposit(uint256 depositId) external returns (uint256)",
    "function deposits(uint256 depositId) external view returns (address user, uint256 amount, bytes32 poolId, uint64 createdAt, bool released, bool refunded)",
    "function nextDepositId() external view returns (uint256)",
    "function refundWindow() external view returns (uint256)",
    "function totalLockedUsdc() external view returns (uint256)",
    "function setRelayer(address relayer, bool authorized) external",
    "function setRefundWindow(uint256 newWindow) external",
    "function pause() external",
    "function unpause() external",
    "function paused() external view returns (bool)",
    "event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId)",
    "event DepositReleased(uint256 indexed depositId, address indexed to, uint256 amount)",
    "event DepositRefunded(uint256 indexed depositId, address indexed user, uint256 amount)",
    "event RelayerUpdated(address indexed relayer, bool authorized)",
    "event RefundWindowUpdated(uint256 newWindow)"
  ]
} as const;
