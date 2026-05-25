export const BASE_DEPOSIT_RECEIVER = {
  name: "BaseDepositReceiver",
  abi: [
    "function depositUSDC(uint256 amount, bytes32 poolId) external returns (uint256)",
    "function releaseDeposit(uint256 depositId, address to) external returns (uint256)",
    "function deposits(uint256 depositId) external view returns (address user, uint256 amount, bytes32 poolId, bool released)",
    "function nextDepositId() external view returns (uint256)",
    "function setRelayer(address relayer, bool authorized) external",
    "event DepositReceived(uint256 indexed depositId, address indexed user, address token, uint256 amount, bytes32 poolId)",
    "event DepositReleased(uint256 indexed depositId, address indexed to, uint256 amount)"
  ]
} as const;
