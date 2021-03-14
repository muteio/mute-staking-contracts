pragma solidity 0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/IERC20.sol";

contract TokenPool {
    IERC20 public token;

    address public _owner;

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: caller is not the owner");
        _;
    }

    constructor(IERC20 _token) public {
        token = _token;
        _owner = msg.sender;
    }

    function balance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function transfer(address to, uint256 value) external onlyOwner returns (bool) {
        return token.transfer(to, value);
    }

    function rescueFunds(address tokenToRescue, address to, uint256 amount) external onlyOwner returns (bool) {
        require(address(token) != tokenToRescue, 'TokenPool: Cannot claim token held by the contract');

        return IERC20(tokenToRescue).transfer(to, amount);
    }
}
