export const UNISWAP_V2_ROUTER = {
  name: "UniswapV2Router",
  abi: [
    "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts)"
  ]
} as const;

