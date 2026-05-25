// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {USDC4626Vault} from "./USDC4626Vault.sol";

contract ClubVaultFactory is Ownable {
    IERC20 public immutable asset;
    mapping(bytes32 => address) public getVaultByClub;

    event ClubVaultCreated(bytes32 indexed clubId, address indexed vault, string name, string symbol, uint256 depositCap);

    constructor(IERC20 asset_, address initialOwner) Ownable(initialOwner) {
        require(address(asset_) != address(0), "Factory: zero asset");
        asset = asset_;
    }

    function createClubVault(bytes32 clubId, string memory name_, string memory symbol_, uint256 depositCap)
        external
        onlyOwner
        returns (address)
    {
        require(clubId != bytes32(0), "Factory: zero clubId");
        require(getVaultByClub[clubId] == address(0), "Factory: vault exists");

        USDC4626Vault vault = new USDC4626Vault(asset, name_, symbol_, depositCap, owner());
        getVaultByClub[clubId] = address(vault);
        emit ClubVaultCreated(clubId, address(vault), name_, symbol_, depositCap);
        return address(vault);
    }
}
