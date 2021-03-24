pragma solidity 0.5.0;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/token/ERC20/IERC20.sol";

import "./TokenPool.sol";

contract TokenGeyser {
    using SafeMath for uint256;

    event Staked(address indexed user, uint256 amount, uint256 total, bytes data);
    event Unstaked(address indexed user, uint256 amount, uint256 total, bytes data);
    event TokensClaimed(address indexed user, uint256 amount);
    event TokensLocked(uint256 amount, uint256 durationSec, uint256 total);
    event TokensAdded(uint256 amount, uint256 total);
    event TokensUnlocked(uint256 amount, uint256 total);

    TokenPool private _stakingPool;
    TokenPool private _unlockedPool;
    TokenPool private _lockedPool;

    //
    // Time-bonus params
    //
    uint256 public startBonus = 0;
    uint256 public bonusPeriodSec = 0;

    //
    // Global accounting state
    //
    uint256 public totalLockedTokens = 0;
    uint256 public totalStakingTokens = 0;
    uint256 private _totalStakingTokensSeconds = 0;
    uint256 private _lastAccountingTimestampSec = now;

    //
    // User accounting state
    //
    // Represents a single stake for a user. A user may have multiple.
    struct Stake {
        uint256 stakingTokens;
        uint256 timestampSec;
    }

    // Caches aggregated values from the User->Stake[] map to save computation.
    // If lastAccountingTimestampSec is 0, there's no entry for that user.
    struct UserTotals {
        uint256 stakingTokens;
        uint256 stakingTokensSeconds;
        uint256 lastAccountingTimestampSec;
    }

    // Aggregated staking values per user
    mapping(address => UserTotals) private _userTotals;

    // The collection of stakes for each user. Ordered by timestamp, earliest to latest.
    mapping(address => Stake[]) private _userStakes;

    //
    // Locked/Unlocked Accounting state
    //
    struct UnlockSchedule {
        uint256 initialLockedTokens;
        uint256 unlockedTokens;
        uint256 lastUnlockTimestampSec;
        uint256 endAtSec;
        uint256 durationSec;
    }

    UnlockSchedule[] public unlockSchedules;

    address public _owner;

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: caller is not the owner");
        _;
    }

    constructor(IERC20 stakingToken, IERC20 distributionToken, uint256 _startBonus, uint256 _bonusPeriod) public {
        _stakingPool = new TokenPool(stakingToken);
        _unlockedPool = new TokenPool(distributionToken);
        _lockedPool = new TokenPool(distributionToken);
        startBonus = _startBonus; //33;
        bonusPeriodSec = _bonusPeriod; //5184000; // 60 days
        _owner = msg.sender;
    }

    function getStakingToken() public view returns (IERC20) {
        return _stakingPool.token();
    }

    function getDistributionToken() public view returns (IERC20) {
        return _unlockedPool.token();
    }

    function stake(uint256 amount, bytes calldata data) external {
        _stakeFor(msg.sender, msg.sender, amount);
    }

    function _stakeFor(address staker, address beneficiary, uint256 amount) private {
        require(amount > 0, 'TokenGeyser: stake amount is zero');
        require(beneficiary != address(0), 'TokenGeyser: beneficiary is zero address');
        require(totalStakingTokens == 0 || totalStaked() > 0,
                'TokenGeyser: Invalid state. Staking shares exist, but no staking tokens do');

        require(amount > 0, 'TokenGeyser: Stake amount is too small');

        updateAccounting();

        // 1. User Accounting
        UserTotals storage totals = _userTotals[beneficiary];
        totals.stakingTokens = totals.stakingTokens.add(amount);
        totals.lastAccountingTimestampSec = now;

        Stake memory newStake = Stake(amount, now);
        _userStakes[beneficiary].push(newStake);

        // 2. Global Accounting
        totalStakingTokens = totalStakingTokens.add(amount);

        // interactions
        require(_stakingPool.token().transferFrom(staker, address(_stakingPool), amount),
            'TokenGeyser: transfer into staking pool failed');

        emit Staked(beneficiary, amount, totalStakedFor(beneficiary), "");
    }

    function unstake(uint256 amount, bytes calldata data) external {
        _unstake(amount);
    }

    function unstakeQuery(uint256 amount) public returns (uint256) {
        return _unstake(amount);
    }

    function _unstake(uint256 amount) private returns (uint256) {
        updateAccounting();
        // checks
        require(amount > 0, 'TokenGeyser: unstake amount is zero');
        require(totalStakedFor(msg.sender) >= amount,
            'TokenGeyser: unstake amount is greater than total user stakes');

        // 1. User Accounting
        UserTotals storage totals = _userTotals[msg.sender];
        Stake[] storage accountStakes = _userStakes[msg.sender];

        // Redeem from most recent stake and go backwards in time.
        uint256 stakingTokensSecondsToBurn = 0;
        uint256 sharesLeftToBurn = amount;
        uint256 rewardAmount = 0;
        while (sharesLeftToBurn > 0) {
            Stake storage lastStake = accountStakes[accountStakes.length - 1];
            uint256 stakeTimeSec = now.sub(lastStake.timestampSec);
            uint256 newstakingTokensSecondsToBurn = 0;
            if (lastStake.stakingTokens <= sharesLeftToBurn) {
                // fully redeem a past stake
                newstakingTokensSecondsToBurn = lastStake.stakingTokens.mul(stakeTimeSec);
                rewardAmount = computeNewReward(rewardAmount, newstakingTokensSecondsToBurn, stakeTimeSec);
                stakingTokensSecondsToBurn = stakingTokensSecondsToBurn.add(newstakingTokensSecondsToBurn);
                sharesLeftToBurn = sharesLeftToBurn.sub(lastStake.stakingTokens);
                accountStakes.length--;
            } else {
                // partially redeem a past stake
                newstakingTokensSecondsToBurn = sharesLeftToBurn.mul(stakeTimeSec);
                rewardAmount = computeNewReward(rewardAmount, newstakingTokensSecondsToBurn, stakeTimeSec);
                stakingTokensSecondsToBurn = stakingTokensSecondsToBurn.add(newstakingTokensSecondsToBurn);
                lastStake.stakingTokens = lastStake.stakingTokens.sub(sharesLeftToBurn);
                sharesLeftToBurn = 0;
            }
        }
        totals.stakingTokensSeconds = totals.stakingTokensSeconds.sub(stakingTokensSecondsToBurn);
        totals.stakingTokens = totals.stakingTokens.sub(amount);

        // 2. Global Accounting
        _totalStakingTokensSeconds = _totalStakingTokensSeconds.sub(stakingTokensSecondsToBurn);
        totalStakingTokens = totalStakingTokens.sub(amount);

        // unlock 99% only, leave 1% locked as a liquidity tax
        uint256 amountMinusTax = amount.mul(99).div(100);
        uint256 amountTax = amount.sub(amountMinusTax);
        // interactions
        require(_stakingPool.transfer(msg.sender, amountMinusTax),
            'TokenGeyser: transfer out of staking pool failed');
        require(_stakingPool.transfer(address(this), amountTax),
            'TokenGeyser: transfer out of staking pool failed');
        require(_unlockedPool.transfer(msg.sender, rewardAmount),
            'TokenGeyser: transfer out of unlocked pool failed');

        emit Unstaked(msg.sender, amountMinusTax, totalStakedFor(msg.sender), "");
        emit TokensClaimed(msg.sender, rewardAmount);

        require(totalStakingTokens == 0 || totalStaked() > 0,
                "TokenGeyser: Error unstaking. Staking shares exist, but no staking tokens do");
        return rewardAmount;
    }

    function computeNewReward(uint256 currentRewardTokens, uint256 stakingTokensSeconds, uint256 stakeTimeSec) private view returns (uint256) {

        uint256 newRewardTokens = totalUnlocked().mul(stakingTokensSeconds).div(_totalStakingTokensSeconds);

        if (stakeTimeSec >= bonusPeriodSec) {
            return currentRewardTokens.add(newRewardTokens);
        }

        uint256 oneHundredPct = 100;
        uint256 bonusedReward =
            startBonus
            .add(oneHundredPct.sub(startBonus).mul(stakeTimeSec).div(bonusPeriodSec))
            .mul(newRewardTokens)
            .div(oneHundredPct);
        return currentRewardTokens.add(bonusedReward);
    }

    function totalStakedFor(address addr) public view returns (uint256) {
        return totalStakingTokens > 0 ?
            totalStaked().mul(_userTotals[addr].stakingTokens).div(totalStakingTokens) : 0;
    }

    function totalStaked() public view returns (uint256) {
        return _stakingPool.balance();
    }

    function token() external view returns (address) {
        return address(getStakingToken());
    }

    function updateAccounting() public returns (uint256, uint256, uint256, uint256, uint256, uint256) {

        unlockTokens();

        // Global accounting
        uint256 newstakingTokensSeconds =
            now
            .sub(_lastAccountingTimestampSec)
            .mul(totalStakingTokens);
        _totalStakingTokensSeconds = _totalStakingTokensSeconds.add(newstakingTokensSeconds);
        _lastAccountingTimestampSec = now;

        // User Accounting
        UserTotals storage totals = _userTotals[msg.sender];
        uint256 newUserstakingTokensSeconds =
            now
            .sub(totals.lastAccountingTimestampSec)
            .mul(totals.stakingTokens);
        totals.stakingTokensSeconds =
            totals.stakingTokensSeconds
            .add(newUserstakingTokensSeconds);
        totals.lastAccountingTimestampSec = now;

        uint256 totalUserRewards = (_totalStakingTokensSeconds > 0)
            ? totalUnlocked().mul(totals.stakingTokensSeconds).div(_totalStakingTokensSeconds)
            : 0;

        return (
            totalLocked(),
            totalUnlocked(),
            totals.stakingTokensSeconds,
            _totalStakingTokensSeconds,
            totalUserRewards,
            now
        );
    }

    function totalLocked() public view returns (uint256) {
        return _lockedPool.balance();
    }

    function totalUnlocked() public view returns (uint256) {
        return _unlockedPool.balance();
    }

    function unlockScheduleCount() public view returns (uint256) {
        return unlockSchedules.length;
    }

    function lockTokens(uint256 amount, uint256 durationSec) external onlyOwner {
        // Update lockedTokens amount before using it in computations after.
        updateAccounting();

        uint256 lockedTokens = totalLocked();

        UnlockSchedule memory schedule;
        schedule.initialLockedTokens = amount;
        schedule.lastUnlockTimestampSec = now;
        schedule.endAtSec = now.add(durationSec);
        schedule.durationSec = durationSec;
        unlockSchedules.push(schedule);

        totalLockedTokens = lockedTokens.add(amount);

        require(_lockedPool.token().transferFrom(msg.sender, address(_lockedPool), amount),
            'TokenGeyser: transfer into locked pool failed');
        emit TokensLocked(amount, durationSec, totalLocked());
    }

    function addTokens(uint256 amount) external {
        UnlockSchedule storage schedule = unlockSchedules[unlockSchedules.length - 1];

        // if we don't have an active schedule, create one
        if(schedule.endAtSec < now){
          uint256 lockedTokens = totalLocked();

          UnlockSchedule memory schedule;
          schedule.initialLockedTokens = amount;
          schedule.lastUnlockTimestampSec = now;
          schedule.endAtSec = now.add(60 * 60 * 24 * 135);
          schedule.durationSec = 60 * 60 * 24 * 135;
          unlockSchedules.push(schedule);

          totalLockedTokens = lockedTokens.add(amount);

          require(_lockedPool.token().transferFrom(msg.sender, address(_lockedPool), amount),
              'TokenGeyser: transfer into locked pool failed');
          emit TokensLocked(amount, 60 * 60 * 24 * 135, totalLocked());
        } else {
          // normalize the amount weight to offset lost time
          uint256 mintedLockedShares = amount.mul(schedule.durationSec.div(schedule.endAtSec.sub(now)));
          schedule.initialLockedTokens = schedule.initialLockedTokens.add(mintedLockedShares);

          uint256 balanceBefore = _lockedPool.token().balanceOf(address(_lockedPool));
          require(_lockedPool.token().transferFrom(msg.sender, address(_lockedPool), amount),
              'TokenGeyser: transfer into locked pool failed');
          uint256 balanceAfter = _lockedPool.token().balanceOf(address(_lockedPool));

          totalLockedTokens = totalLockedTokens.add(balanceAfter.sub(balanceBefore));
          emit TokensAdded(balanceAfter.sub(balanceBefore), totalLocked());
        }

    }

    function unlockTokens() public returns (uint256) {
        uint256 unlockedTokens = 0;

        if (totalLockedTokens == 0) {
            unlockedTokens = totalLocked();
        } else {
            for (uint256 s = 0; s < unlockSchedules.length; s++) {
                unlockedTokens = unlockedTokens.add(unlockScheduleShares(s));
            }
            totalLockedTokens = totalLockedTokens.sub(unlockedTokens);
        }

        if (unlockedTokens > 0) {
            require(_lockedPool.transfer(address(_unlockedPool), unlockedTokens),
                'TokenGeyser: transfer out of locked pool failed');
            emit TokensUnlocked(unlockedTokens, totalLocked());
        }

        return unlockedTokens;
    }

    function unlockScheduleShares(uint256 s) private returns (uint256) {
        UnlockSchedule storage schedule = unlockSchedules[s];

        if(schedule.unlockedTokens >= schedule.initialLockedTokens) {
            return 0;
        }

        uint256 sharesToUnlock = 0;
        // Special case to handle any leftover dust from integer division
        if (now >= schedule.endAtSec) {
            sharesToUnlock = (schedule.initialLockedTokens.sub(schedule.unlockedTokens));
            schedule.lastUnlockTimestampSec = schedule.endAtSec;
        } else {
            sharesToUnlock = now.sub(schedule.lastUnlockTimestampSec)
                .mul(schedule.initialLockedTokens)
                .div(schedule.durationSec);
            schedule.lastUnlockTimestampSec = now;
        }

        schedule.unlockedTokens = schedule.unlockedTokens.add(sharesToUnlock);
        return sharesToUnlock;
    }

    function rescueFundsFromStakingPool(address tokenToRescue, address to, uint256 amount) public onlyOwner returns (bool) {
        return _stakingPool.rescueFunds(tokenToRescue, to, amount);
    }
}
