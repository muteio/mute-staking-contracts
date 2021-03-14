const { contract, web3, accounts } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;

const {
  $TOKEN,
  checkTokenAprox,
  TimeController
} = _require('/test/helper');

const MockERC20 = contract.fromArtifact('MockErc20');
const TokenGeyser = contract.fromArtifact('TokenGeyser');
const ONE_YEAR = 1 * 365 * 24 * 3600;

let stakingToken, dist, owner, anotherAccount;
async function setupContractAndAccounts () {
  const [_owner, user1] =  accounts;

  owner = _owner;
  anotherAccount = user1;

  stakingToken = await MockERC20.new($TOKEN(100000), {from: owner});

  const startBonus = 50; // 50%
  const bonusPeriod = 86400; // 1 Day
  dist = await TokenGeyser.new(stakingToken.address, stakingToken.address, startBonus, bonusPeriod, {from: owner});

  await stakingToken.transfer(anotherAccount, $TOKEN(25000), {from: owner});
  await stakingToken.approve(dist.address, $TOKEN(50000), { from: anotherAccount });
  await stakingToken.approve(dist.address, $TOKEN(50000), { from: owner });
}

async function totalRewardsFor (account) {
  return (await dist.updateAccounting.call({ from: account }))[4];
}

describe('unstaking', function () {
  beforeEach('setup contracts', async function () {
    await setupContractAndAccounts();
  });

  describe('unstake', function () {
    describe('when amount is 0', function () {
      it('should fail', async function () {
        await dist.stake($TOKEN(50), [], { from: anotherAccount });
        await expectRevert(
          dist.unstake($TOKEN(0), [], { from: anotherAccount }),
          'TokenGeyser: unstake amount is zero'
        );
      });
    });

    describe('when single user stakes once', function () {
      // 100 stakingTokens locked for 1 year, user stakes 50 stakingTokens for 1 year
      // user is eligible for 100% of the reward,
      // unstakes 30 stakingTokens, gets 60% of the reward (60 stakingToken)
      // user's final balance is 90 stakingToken, (20 remains staked), eligible rewards (40 stakingToken)
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
        await timeController.initialize();
        await dist.stake($TOKEN(50), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.updateAccounting({ from: anotherAccount });
        checkTokenAprox(await totalRewardsFor(anotherAccount), 100);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(20));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(20));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 40);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await stakingToken.balanceOf.call(anotherAccount);
        await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        const b = await stakingToken.balanceOf.call(anotherAccount);
        checkTokenAprox(b.sub(_b), 90, 30);
      });
      it('should log Unstaked', async function () {
        const r = await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $TOKEN(30, 30),
          total: $TOKEN(20)
        });
      });
      it('should log TokensClaimed', async function () {
        const r = await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $TOKEN(60)
        });
      });
    });

    describe('when single user unstake early with early bonus', function () {
      // Start bonus = 50%, Bonus Period = 1 Day.
      // 1000 stakingTokens locked for 1 hour, so all will be unlocked by test-time.
      // user stakes 500 stakingTokens for 12 hours, half the period.
      // user is eligible for 75% of the max reward,
      // unstakes 250 stakingTokens, gets .5 * .75 * 1000 stakingTokens
      // user's final balance is 625 stakingToken, (250 remains staked), eligible rewards (375 stakingToken)
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(1000), ONE_HOUR, {from: owner});
        timeController.initialize();
        await dist.stake($TOKEN(500), [], { from: anotherAccount });
        await timeController.advanceTime(12 * ONE_HOUR);
        await dist.updateAccounting({ from: anotherAccount });
        checkTokenAprox(await totalRewardsFor(anotherAccount), 1000);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($TOKEN(250), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(250));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(250));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 625); // (.5 * .75 * 1000) + 250
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await stakingToken.balanceOf.call(anotherAccount);
        await dist.unstake($TOKEN(250), [], { from: anotherAccount });
        const b = await stakingToken.balanceOf.call(anotherAccount);
        checkTokenAprox(b.sub(_b), 625, 250);
      });
      it('should log Unstaked', async function () {
        const r = await dist.unstake($TOKEN(250), [], { from: anotherAccount });
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $TOKEN(250, 250),
          total: $TOKEN(250)
        });
      });
      it('should log TokensClaimed', async function () {
        const r = await dist.unstake($TOKEN(250), [], { from: anotherAccount });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $TOKEN(375) // .5 * .75 * 1000
        });
      });
    });

    describe('when single user stakes many times', function () {
      // 100 stakingTokens locked for 1 year,
      // user stakes 50 stakingTokens for 1/2 year, 50 stakingTokens for 1/4 year, [50 stakingTokens unlocked in this time ]
      // unstakes 30 stakingTokens, gets 20% of the unlocked reward (10 stakingToken) ~ [30 * 0.25 / (50*0.25+50*0.5) * 50]
      // user's final balance is 40 stakingToken
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 100);
        await dist.stake($TOKEN(50), [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($TOKEN(50), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.updateAccounting({ from: anotherAccount });
      });
      it('checkTotalRewards', async function () {
        checkTokenAprox(await totalRewardsFor(anotherAccount), 51);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(70));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(70));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 40.8);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await stakingToken.balanceOf.call(anotherAccount);
        await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        const b = await stakingToken.balanceOf.call(anotherAccount);
        checkTokenAprox(b.sub(_b), 40.2, 30);
      });
    });

    describe('when single user performs unstake many times', function () {
      // 100 stakingTokens locked for 1 year,
      // user stakes 10 stakingTokens, waits 1 year, stakes 10 stakingTokens, waits 1 year,
      // unstakes 5 stakingToken, unstakes 5 stakingToken, unstakes 5 stakingToken
      // 3rd unstake should be worth twice the first one
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
        await timeController.initialize();
        await dist.stake($TOKEN(10), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.stake($TOKEN(10), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.updateAccounting({ from: anotherAccount });
        checkTokenAprox(await totalRewardsFor(anotherAccount), 100);
      });

      it('should use updated user accounting', async function () {
        const r1 = await dist.unstake($TOKEN(5), [], { from: anotherAccount });
        expectEvent(r1, 'TokensClaimed', {
          user: anotherAccount
        });
        const l1 = r1.logs.filter(l => l.event === 'TokensClaimed')[0];
        const claim1 = l1.args.amount;
        const r2 = await dist.unstake($TOKEN(5), [], { from: anotherAccount });
        expectEvent(r2, 'TokensClaimed', {
          user: anotherAccount
        });
        const r3 = await dist.unstake($TOKEN(5), [], { from: anotherAccount });
        expectEvent(r3, 'TokensClaimed', {
          user: anotherAccount
        });
        const l3 = r3.logs.filter(l => l.event === 'TokensClaimed')[0];
        const claim3 = l3.args.amount;
        const ratio = claim3.mul(new BN(100)).div(claim1);
        expect(ratio).to.be.bignumber.gte('199').and.bignumber.below('201');
      });
    });

    describe('when multiple users stake once', function () {
      // 100 stakingTokens locked for 1 year,
      // userA stakes 50 stakingTokens for 3/4 year, userb stakes 50 stakingToken for 1/2 year, total unlocked 75 stakingToken
      // userA unstakes 30 stakingTokens, gets 36% of the unlocked reward (27 stakingToken) ~ [30 * 0.75 / (50*0.75+50*0.5) * 75]
      // user's final balance is 57 stakingToken
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 100);
        await dist.stake($TOKEN(50), [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($TOKEN(50), [], {from: owner});
        await timeController.advanceTime(ONE_YEAR / 2);
        await dist.updateAccounting({ from: anotherAccount });
        await dist.updateAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(100));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 45.6);
        checkTokenAprox(await totalRewardsFor(owner), 30.4);
      });
      it('checkTotalRewards', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(100));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 45.6);
        checkTokenAprox(await totalRewardsFor(owner), 30.4);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(70));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(20));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(50));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 18.24);
        checkTokenAprox(await totalRewardsFor(owner), 30.4);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await stakingToken.balanceOf.call(anotherAccount);
        await dist.unstake($TOKEN(30), [], { from: anotherAccount });
        const b = await stakingToken.balanceOf.call(anotherAccount);
        checkTokenAprox(b.sub(_b), 57.36, 30);
      });
    });

    describe('when multiple users stake many times', function () {
      // 10000 stakingTokens locked for 1 year,
      // userA stakes 5000 stakingTokens for 3/4 year, and 5000 stakingTokens for 1/4 year
      // userb stakes 5000 stakingTokens for 1/2 year and 3000 stakingTokens for 1/4 year
      // userA unstakes 10000 stakingTokens, gets 60.60% of the unlocked reward (4545 stakingToken)
      //        ~ [5000*0.75+5000*0.25 / (5000*0.75+5000*0.25+5000*0.5+3000*0.25) * 7500]
      // user's final balance is 14545 stakingToken
      // userb unstakes 8000 stakingTokens, gets the 10955 stakingToken
      const timeController = new TimeController();
      const rewardsAnotherAccount = 50000.0 / 11.0;
      const rewardsOwner = 32500.0 / 11.0;
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(10000), ONE_YEAR, {from: owner});
        await dist.stake($TOKEN(5000), [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($TOKEN(5000), [], {from: owner});
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($TOKEN(5000), [], { from: anotherAccount });
        await dist.stake($TOKEN(3000), [], {from: owner});
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.updateAccounting({ from: anotherAccount });
        await dist.updateAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(18000));
        checkTokenAprox(await totalRewardsFor(anotherAccount), rewardsAnotherAccount);
        checkTokenAprox(await totalRewardsFor(owner), rewardsOwner);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($TOKEN(10000), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(8000));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(8000));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 0);
        checkTokenAprox(await totalRewardsFor(owner), rewardsOwner);
        await dist.unstake($TOKEN(8000), [], {from: owner});
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(0));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(0));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 0);
        checkTokenAprox(await totalRewardsFor(owner), 0);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const b1 = await stakingToken.balanceOf.call(anotherAccount);
        await dist.unstake($TOKEN(10000), [], { from: anotherAccount });
        const b2 = await stakingToken.balanceOf.call(anotherAccount);
        checkTokenAprox(b2.sub(b1), 10000 + rewardsAnotherAccount, 10000);
        const b3 = await stakingToken.balanceOf.call(owner);
        await dist.unstake($TOKEN(8000), [], {from: owner});
        const b4 = await stakingToken.balanceOf.call(owner);
        checkTokenAprox(b4.sub(b3), 8000 + rewardsOwner, 8000);
      });
    });

    describe('when multiple users stake many times and tokens are added', function () {
      // 10000 stakingTokens locked for 1 year,
      // userA stakes 5000 stakingTokens for 3/4 year, and 5000 stakingTokens for 1/4 year
      // userb stakes 5000 stakingTokens for 1/2 year and 3000 stakingTokens for 1/4 year
      // userA unstakes 10000 stakingTokens, gets 60.60% of the unlocked reward (4545 stakingToken)
      //        ~ [5000*0.75+5000*0.25 / (5000*0.75+5000*0.25+5000*0.5+3000*0.25) * 7500]
      // user's final balance is 14545 stakingToken
      // userb unstakes 8000 stakingTokens, gets the 10955 stakingToken
      const timeController = new TimeController();
      const rewardsAnotherAccount = 7575;
      const rewardsOwner = 4924;
      beforeEach(async function () {
        await dist.lockTokens($TOKEN(10000), ONE_YEAR, {from: owner});
        await dist.stake($TOKEN(5000), [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($TOKEN(5000), [], {from: owner});
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($TOKEN(5000), [], { from: anotherAccount });
        await dist.stake($TOKEN(3000), [], {from: owner}); // 3250 weight
        await dist.addTokens($TOKEN(10000), {from: owner}); // 30k equiv to contract instead of 10k
        await timeController.advanceTime(ONE_YEAR / 4); // 7500 unlocked so far
        await dist.updateAccounting({ from: anotherAccount });
        await dist.updateAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(18000));
        checkTokenAprox(await totalRewardsFor(anotherAccount), rewardsAnotherAccount);
        checkTokenAprox(await totalRewardsFor(owner), rewardsOwner);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($TOKEN(10000), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(8000));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(8000));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 0);
        checkTokenAprox(await totalRewardsFor(owner), rewardsOwner);
        await dist.unstake($TOKEN(8000), [], {from: owner});
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(0));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(0));
        checkTokenAprox(await totalRewardsFor(anotherAccount), 0);
        checkTokenAprox(await totalRewardsFor(owner), 0);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const b1 = await stakingToken.balanceOf.call(anotherAccount);
        await dist.unstake($TOKEN(10000), [], { from: anotherAccount });
        const b2 = await stakingToken.balanceOf.call(anotherAccount);
        checkTokenAprox(b2.sub(b1), 10000 + rewardsAnotherAccount, 10000);
        const b3 = await stakingToken.balanceOf.call(owner);
        await dist.unstake($TOKEN(8000), [], {from: owner});
        const b4 = await stakingToken.balanceOf.call(owner);
        checkTokenAprox(b4.sub(b3), 8000 + rewardsOwner, 8000);
      });
    });

  });

  describe('unstakeQuery', function () {
    // 100 stakingTokens locked for 1 year, user stakes 50 stakingTokens for 1 year
    // user is eligible for 100% of the reward,
    // unstakes 30 stakingTokens, gets 60% of the reward (60 stakingToken)
    const timeController = new TimeController();
    beforeEach(async function () {
      await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
      await dist.stake($TOKEN(50), [], { from: anotherAccount });
      await timeController.initialize();
      await timeController.advanceTime(ONE_YEAR);
      await dist.updateAccounting({ from: anotherAccount });
    });
    it('should return the reward amount', async function () {
      checkTokenAprox(await totalRewardsFor(anotherAccount), 100);
      const a = await dist.unstakeQuery.call($TOKEN(30), { from: anotherAccount });
      checkTokenAprox(a, 60);
    });
  });
});
