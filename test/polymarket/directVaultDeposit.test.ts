import { strict as assert } from "assert";
import { Interface } from "ethers";
import { readSingleVaultDeposit } from "../../src/polymarket/directVaultDeposit";

describe("direct Polygon pUSD deposit receipt", () => {
  const vault = "0x1111111111111111111111111111111111111111";
  const owner = "0x2222222222222222222222222222222222222222";
  const otherVault = "0x3333333333333333333333333333333333333333";
  const abi = new Interface([
    "event Deposit(address indexed caller,address indexed owner,uint256 assets,uint256 shares)",
  ]);
  const deposit = abi.getEvent("Deposit")!;
  const encoded = abi.encodeEventLog(deposit, [owner, owner, 1_000_000n, 950_000n]);
  const log = { address: vault, data: encoded.data, topics: encoded.topics };

  it("attributes shares to the owner in the expected vault event", () => {
    assert.deepEqual(readSingleVaultDeposit([log], vault), {
      owner,
      assets: 1_000_000n,
      shares: 950_000n,
    });
  });

  it("rejects a receipt from another vault or with multiple deposits", () => {
    assert.throws(() => readSingleVaultDeposit([log], otherVault));
    assert.throws(() => readSingleVaultDeposit([log, log], vault));
  });
});
