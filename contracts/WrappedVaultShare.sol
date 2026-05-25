// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract WrappedVaultShare is ERC20, Ownable, Pausable {
    mapping(address => bool) public minters;

    event MinterUpdated(address indexed minter, bool authorized);
    event SharesMinted(address indexed to, uint256 amount, bytes32 indexed polygonDepositId);
    event SharesBurned(address indexed from, uint256 amount, bytes32 indexed redemptionId);

    constructor(string memory name_, string memory symbol_, address initialOwner) ERC20(name_, symbol_) Ownable(initialOwner) {}

    modifier onlyMinter() {
        require(minters[msg.sender] || msg.sender == owner(), "WrappedShare: unauthorized minter");
        _;
    }

    function setMinter(address minter, bool authorized) external onlyOwner {
        require(minter != address(0), "WrappedShare: zero minter");
        minters[minter] = authorized;
        emit MinterUpdated(minter, authorized);
    }

    function mint(address to, uint256 amount, bytes32 polygonDepositId) external onlyMinter whenNotPaused {
        _mint(to, amount);
        emit SharesMinted(to, amount, polygonDepositId);
    }

    function burn(address from, uint256 amount, bytes32 redemptionId) external onlyMinter whenNotPaused {
        _burn(from, amount);
        emit SharesBurned(from, amount, redemptionId);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
