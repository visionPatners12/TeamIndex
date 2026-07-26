// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TeamIndexPUSDVaultV2} from "./TeamIndexPUSDVaultV2.sol";
import {TeamIndexRegistryV2} from "./TeamIndexRegistryV2.sol";

/// @title TeamIndexVaultFactoryV2
/// @notice Deploys versioned Polygon pUSD vault clones and registers their Deposit Wallets atomically.
contract TeamIndexVaultFactoryV2 is Ownable {
    IERC20 public immutable asset;
    address public immutable implementation;
    TeamIndexRegistryV2 public immutable registry;

    address public defaultOperator;
    address public defaultValuator;
    uint256 public defaultExternalAllocationBps = 3_000;
    uint256 public defaultIdleReserveBps = 2_000;
    uint256 public defaultMaxValuationAge = 15 minutes;

    mapping(bytes32 => address) public getVaultByPool;

    event PoolVaultCreated(
        bytes32 indexed poolId,
        address indexed vault,
        address indexed depositWallet,
        address depositWalletOwner,
        uint256 depositCap
    );
    event DefaultsUpdated(
        address indexed operator,
        address indexed valuator,
        uint256 externalAllocationBps,
        uint256 idleReserveBps,
        uint256 maxValuationAge
    );

    error InvalidAddress();
    error PoolExists();

    constructor(
        IERC20 asset_,
        address implementation_,
        TeamIndexRegistryV2 registry_,
        address initialOwner,
        address defaultOperator_,
        address defaultValuator_
    ) Ownable(initialOwner) {
        if (
            address(asset_) == address(0) || implementation_ == address(0) || address(registry_) == address(0)
                || defaultOperator_ == address(0) || defaultValuator_ == address(0)
        ) revert InvalidAddress();
        asset = asset_;
        implementation = implementation_;
        registry = registry_;
        defaultOperator = defaultOperator_;
        defaultValuator = defaultValuator_;
    }

    function createPoolVault(
        bytes32 poolId,
        string calldata name,
        string calldata symbol,
        uint256 depositCap,
        address depositWallet,
        address depositWalletOwner
    ) external onlyOwner returns (address vault) {
        if (getVaultByPool[poolId] != address(0)) revert PoolExists();
        if (poolId == bytes32(0) || depositWallet == address(0) || depositWalletOwner == address(0)) {
            revert InvalidAddress();
        }

        vault = Clones.clone(implementation);
        TeamIndexPUSDVaultV2(vault).initialize(
            asset,
            name,
            symbol,
            depositCap,
            owner(),
            defaultOperator,
            defaultValuator,
            depositWallet,
            defaultExternalAllocationBps,
            defaultIdleReserveBps,
            defaultMaxValuationAge
        );
        getVaultByPool[poolId] = vault;
        registry.registerPool(poolId, vault, depositWallet, depositWalletOwner);
        emit PoolVaultCreated(poolId, vault, depositWallet, depositWalletOwner, depositCap);
    }

    function setDefaults(
        address operator_,
        address valuator_,
        uint256 externalAllocationBps,
        uint256 idleReserveBps,
        uint256 maxValuationAge
    ) external onlyOwner {
        if (operator_ == address(0) || valuator_ == address(0)) revert InvalidAddress();
        if (
            externalAllocationBps > TeamIndexPUSDVaultV2(implementation).MAX_EXTERNAL_ALLOCATION_BPS()
                || idleReserveBps > 10_000 || externalAllocationBps + idleReserveBps > 10_000
                || maxValuationAge == 0
        ) revert InvalidAddress();
        defaultOperator = operator_;
        defaultValuator = valuator_;
        defaultExternalAllocationBps = externalAllocationBps;
        defaultIdleReserveBps = idleReserveBps;
        defaultMaxValuationAge = maxValuationAge;
        emit DefaultsUpdated(operator_, valuator_, externalAllocationBps, idleReserveBps, maxValuationAge);
    }
}
