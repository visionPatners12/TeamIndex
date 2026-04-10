export const WRAPPED_VAULT_SHARE = {
  name: "WrappedVaultShare",
  abi: [
    "function mint(address to, uint256 amount, bytes32 polygonDepositId) external",
    "function burn(address from, uint256 amount, bytes32 redemptionId) external",
    "function balanceOf(address account) external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
    "function pause() external",
    "function unpause() external",
    "event SharesMinted(address indexed to, uint256 amount, bytes32 indexed polygonDepositId)",
    "event SharesBurned(address indexed from, uint256 amount, bytes32 indexed redemptionId)"
  ]
} as const;
