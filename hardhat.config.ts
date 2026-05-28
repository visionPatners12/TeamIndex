import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      // Vaults are deployed once via Clones but their entry-point functions
      // (deposit/withdraw/executeWhitelistedCall) are called many times.
      // High `runs` minimizes runtime gas for those hot paths.
      optimizer: {
        enabled: true,
        runs: 10_000
      },
      viaIR: true
    }
  },
  paths: {
    sources: "contracts",
    tests: "test/contracts",
    cache: "cache/hardhat",
    artifacts: "artifacts"
  },
  networks: {
    polygon: {
      url: process.env.RPC_URL || "",
      accounts: process.env.EXECUTOR_PRIVATE_KEY ? [process.env.EXECUTOR_PRIVATE_KEY] : []
    },
    base: {
      url: process.env.BASE_RPC_URL || "",
      accounts: process.env.BASE_EXECUTOR_PRIVATE_KEY ? [process.env.BASE_EXECUTOR_PRIVATE_KEY] : []
    },
    chiliz: {
      url: process.env.CHILIZ_RPC_URL || "",
      accounts: process.env.CHILIZ_EXECUTOR_PRIVATE_KEY ? [process.env.CHILIZ_EXECUTOR_PRIVATE_KEY] : []
    }
  }
};

export default config;
