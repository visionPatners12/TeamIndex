// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TeamIndexRegistryV2
/// @notice Immutable one-to-one mapping between a TeamIndex pool, its pUSD vault and Polymarket wallet.
contract TeamIndexRegistryV2 is Ownable {
    struct PoolAccount {
        address vault;
        address depositWallet;
        address depositWalletOwner;
        bool active;
    }

    address public immutable pUSD;
    mapping(address => bool) public registrars;
    mapping(bytes32 => PoolAccount) public pools;
    mapping(address => bytes32) public poolByVault;
    mapping(address => bytes32) public poolByDepositWallet;

    event RegistrarUpdated(address indexed registrar, bool allowed);
    event PoolRegistered(
        bytes32 indexed poolId,
        address indexed vault,
        address indexed depositWallet,
        address depositWalletOwner
    );
    event PoolStatusUpdated(bytes32 indexed poolId, bool active);

    error Unauthorized();
    error InvalidAddress();
    error AlreadyRegistered();
    error UnknownPool();

    constructor(address pUSD_, address initialOwner) Ownable(initialOwner) {
        if (pUSD_ == address(0)) revert InvalidAddress();
        pUSD = pUSD_;
    }

    function setRegistrar(address registrar, bool allowed) external onlyOwner {
        if (registrar == address(0)) revert InvalidAddress();
        registrars[registrar] = allowed;
        emit RegistrarUpdated(registrar, allowed);
    }

    function registerPool(
        bytes32 poolId,
        address vault,
        address depositWallet,
        address depositWalletOwner
    ) external {
        if (!registrars[msg.sender]) revert Unauthorized();
        if (poolId == bytes32(0) || vault == address(0) || depositWallet == address(0) || depositWalletOwner == address(0)) {
            revert InvalidAddress();
        }
        if (
            pools[poolId].vault != address(0) || poolByVault[vault] != bytes32(0)
                || poolByDepositWallet[depositWallet] != bytes32(0)
        ) revert AlreadyRegistered();

        pools[poolId] = PoolAccount(vault, depositWallet, depositWalletOwner, true);
        poolByVault[vault] = poolId;
        poolByDepositWallet[depositWallet] = poolId;
        emit PoolRegistered(poolId, vault, depositWallet, depositWalletOwner);
    }

    function setPoolActive(bytes32 poolId, bool active) external onlyOwner {
        if (pools[poolId].vault == address(0)) revert UnknownPool();
        pools[poolId].active = active;
        emit PoolStatusUpdated(poolId, active);
    }
}
