// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {USDC4626Vault} from "./USDC4626Vault.sol";

/// @title ClubVaultFactory
/// @notice Deploys per-club USDC4626Vault clones via EIP-1167 minimal proxies.
/// @dev    Cloning brings vault deployment cost from ~4M gas down to ~50k gas.
///         Each clone is initialized with the factory's `owner()` as vault owner
///         and `defaultValuator` as the role-limited NAV updater.
contract ClubVaultFactory is Ownable {
    /// @notice Underlying asset (USDC) shared by every clone.
    IERC20 public immutable asset;

    /// @notice Address of the USDC4626Vault implementation used as the clone target.
    address public immutable implementation;

    /// @notice Default valuator wired into every newly-created vault. May be `address(0)`
    ///         to leave it unset (owner-only valuation updates).
    address public defaultValuator;

    mapping(bytes32 => address) public getVaultByClub;

    event ClubVaultCreated(
        bytes32 indexed clubId,
        address indexed vault,
        string name,
        string symbol,
        uint256 depositCap,
        address valuator
    );
    event DefaultValuatorUpdated(address indexed oldValuator, address indexed newValuator);

    constructor(
        IERC20 asset_,
        address implementation_,
        address initialOwner,
        address defaultValuator_
    ) Ownable(initialOwner) {
        require(address(asset_) != address(0), "Factory: zero asset");
        require(implementation_ != address(0), "Factory: zero implementation");
        asset = asset_;
        implementation = implementation_;
        defaultValuator = defaultValuator_;
        if (defaultValuator_ != address(0)) {
            emit DefaultValuatorUpdated(address(0), defaultValuator_);
        }
    }

    /// @notice Updates the default valuator used for future vault deployments.
    /// @dev Does NOT retroactively update existing vaults — call each vault's `setValuator`.
    function setDefaultValuator(address newDefaultValuator) external onlyOwner {
        address old = defaultValuator;
        defaultValuator = newDefaultValuator;
        emit DefaultValuatorUpdated(old, newDefaultValuator);
    }

    /// @notice Deploys a new vault clone for `clubId` and initializes it.
    /// @dev The clone is deterministic (CREATE2) so the address can be predicted off-chain.
    function createClubVault(bytes32 clubId, string memory name_, string memory symbol_, uint256 depositCap)
        external
        onlyOwner
        returns (address vault)
    {
        require(clubId != bytes32(0), "Factory: zero clubId");
        require(getVaultByClub[clubId] == address(0), "Factory: vault exists");

        vault = Clones.cloneDeterministic(implementation, clubId);
        USDC4626Vault(payable(vault)).initialize(asset, name_, symbol_, depositCap, owner(), defaultValuator);

        getVaultByClub[clubId] = vault;
        emit ClubVaultCreated(clubId, vault, name_, symbol_, depositCap, defaultValuator);
    }

    /// @notice Predicts the address of the vault that `createClubVault(clubId, …)` would create.
    function predictVaultAddress(bytes32 clubId) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, clubId, address(this));
    }
}
