// Minimal ABI used by the backend to call permissioned vault functions.
// Keep this local so the backend can be deployed separately from the onchain repo.

export const USDC4626VAULT = {
  name: "USDC4626Vault",
  abi: [
    // Minimal fragment: omit mutability keywords for ethers ABI parsing stability.
    "function executeWhitelistedCall(address target, bytes data, uint256 value, uint256 assetAmount, uint256 minReturn, bool isTrustedRequired) returns (bytes)",

    "function addAuthorizedOperator(address operator, uint256 allocation, uint256 transactionCap) external",
    "function removeAuthorizedOperator(address operator) external",
    "function setOperatorAllocation(address operator, uint256 newAllocation) external",
    "function setOperatorTransactionCap(address operator, uint256 newTxCap) external",

    "function getAllOperators() external view returns (address[])",
    "function getOperatorInfo(address operator) external view returns (bool authorized, uint256 totalAlloc, uint256 currentAlloc, uint256 txCap)",

    "function addWhitelistedContract(address contractAddress) external",
    "function removeWhitelistedContract(address contractAddress) external",

    "function addTrustedStrategy(address strategy) external",
    "function removeTrustedStrategy(address strategy) external",
    "function isTrustedStrategy(address strategy) external view returns (bool)",

    "function isWhitelistedContract(address contractAddress) external view returns (bool)",
    "function getWhitelistedContracts() external view returns (address[])",
    "function getTrustedStrategies() external view returns (address[])",

    "function pause() external",
    "function unpause() external",
    "function paused() external view returns (bool)",

    "function rescueTokens(address token, uint256 amount) external",
    "function rescueNative(uint256 amount) external",

    // ERC4626 / metadata used for sanity checks
    "function asset() external view returns (address)",
    "function totalCash() external view returns (uint256)",
    "function totalAssets() external view returns (uint256)",
    "function depositCap() external view returns (uint256)",
    "function decimals() external view returns (uint8)",

    // ERC4626 user actions used by /tx/* endpoints (populateTransaction)
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function mint(uint256 shares, address receiver) returns (uint256)",
    "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",

    // ERC20 share helpers (for syncing)
    "function totalSupply() external view returns (uint256)",
    "function balanceOf(address) external view returns (uint256)",

    // Ownable helpers (optional)
    "function owner() external view returns (address)",

    // Events used for onchain->DB sync
    "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)",
    "event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
    "event VaultFeeCharged(address indexed payer, address indexed treasury, uint256 grossAssets, uint256 feeAssets, uint256 netAssets)",
    "event PoolValuationUpdated(uint256 openPositionsValue, uint256 realizedPnl)",

    "function setPoolValuation(uint256 openPositionsValue, uint256 realizedPnl) external"
  ]
} as const;

