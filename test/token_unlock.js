const { contract, web3, accounts } = require('@openzeppelin/test-environment');
const { expectRevert, BN, time, constants } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;
const {
  $TOKEN,
  checkTokenAprox,
  checkSharesAprox,
  TimeController
} = _require('/test/helper');

const MockERC20 = contract.fromArtifact('MockErc20');
const TokenGeyser = contract.fromArtifact('TokenGeyser');

const ONE_YEAR = 365 * 24 * 3600;
const START_BONUS = 50;
const BONUS_PERIOD = 86400;

let stakingToken, dist, owner, anotherAccount;
async function setupContractAndAccounts () {
  const [_owner, user1] =  accounts;

  owner = _owner;
  anotherAccount = user1;

  stakingToken = await MockERC20.new($TOKEN(5000), {from: owner});

  dist = await TokenGeyser.new(stakingToken.address, stakingToken.address, START_BONUS, BONUS_PERIOD, {from: owner});
}

async function checkAvailableToUnlock (dist, v) {
  const u = await dist.totalUnlocked.call();
  const r = await dist.updateAccounting.call();
  // console.log('Total unlocked: ', u.toString(), 'total unlocked after: ', r[1].toString());
  checkTokenAprox(r[1].sub(u), v);
}

describe('LockedPool', function () {
  beforeEach('setup contracts', async function () {
    await setupContractAndAccounts();
  });

  describe('getDistributionToken', function () {
    it('should return the staking token', async function () {
      expect(await dist.getDistributionToken.call()).to.equal(stakingToken.address);
    });
  });

  describe('lockTokens', function () {
    describe('when not approved', function () {
      it('should fail', async function () {
        const d = await TokenGeyser.new(stakingToken.address, stakingToken.address, START_BONUS, BONUS_PERIOD, {from: owner});
        await expectRevert.unspecified(d.lockTokens($TOKEN(10), ONE_YEAR, {from: owner}));
      });
    });

    describe('when totalLocked=0', function () {
      beforeEach(async function () {
        checkTokenAprox(await dist.totalLocked.call(), 0);
        await stakingToken.approve(dist.address, $TOKEN(100), {from: owner});
      });
      it('should updated the locked pool balance', async function () {
        await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
        checkTokenAprox(await dist.totalLocked.call(), 100);
      });
      it('should create a schedule', async function () {
        await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
        const s = await dist.unlockSchedules.call(0);
        expect(s[0]).to.be.bignumber.equal($TOKEN(100));
        expect(s[1]).to.be.bignumber.equal($TOKEN(0));
        expect(s[2].add(s[4])).to.be.bignumber.equal(s[3]);
        expect(s[4]).to.be.bignumber.equal(`${ONE_YEAR}`);
        expect(await dist.unlockScheduleCount.call()).to.be.bignumber.equal('1');
      });
      it('should log TokensLocked', async function () {
        const r = await dist.lockTokens($TOKEN(100), ONE_YEAR, { from: owner });
        const l = r.logs.filter(l => l.event === 'TokensLocked')[0];
        checkTokenAprox(l.args.amount, 100);
        checkTokenAprox(l.args.total, 100);
        expect(l.args.durationSec).to.be.bignumber.equal(`${ONE_YEAR}`);
      });
      it('should be protected', async function () {
        await stakingToken.approve(dist.address, $TOKEN(100), { from: owner });
        await expectRevert(dist.lockTokens($TOKEN(50), ONE_YEAR, { from: anotherAccount }),
          'Ownable: caller is not the owner');
        await dist.lockTokens($TOKEN(50), ONE_YEAR, { from: owner });
      });
    });

    describe('when totalLocked>0', function () {
      const timeController = new TimeController();
      beforeEach(async function () {
        await stakingToken.approve(dist.address, $TOKEN(150), { from: owner });
        await dist.lockTokens($TOKEN(100), ONE_YEAR, { from: owner });
        await timeController.initialize();
        checkTokenAprox(await dist.totalLocked.call(), 100);
      });
      it('should updated the locked and unlocked pool balance', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($TOKEN(50), ONE_YEAR, { from: owner });
        checkTokenAprox(await dist.totalLocked.call(), 100 * 0.9 + 50);
      });
      it('should log TokensUnlocked and TokensLocked', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        const r = await dist.lockTokens($TOKEN(50), ONE_YEAR, { from: owner });

        let l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
        checkTokenAprox(l.args.amount, 100 * 0.1);
        checkTokenAprox(l.args.total, 100 * 0.9);

        l = r.logs.filter(l => l.event === 'TokensLocked')[0];
        checkTokenAprox(l.args.amount, 50);
        checkTokenAprox(l.args.total, 100 * 0.9 + 50);
        expect(l.args.durationSec).to.be.bignumber.equal(`${ONE_YEAR}`);
      });
      it('should create a schedule', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($TOKEN(50), ONE_YEAR, { from: owner });
        const s = await dist.unlockSchedules.call(1);
        // struct UnlockSchedule {
        // 0   uint256 initialLockedShares;
        // 1   uint256 unlockedShares;
        // 2   uint256 lastUnlockTimestampSec;
        // 3   uint256 endAtSec;
        // 4   uint256 durationSec;
        // }
        checkSharesAprox(s[0], $TOKEN(50));
        checkSharesAprox(s[1], new BN(0));
        expect(s[2].add(s[4])).to.be.bignumber.equal(s[3]);
        expect(s[4]).to.be.bignumber.equal(`${ONE_YEAR}`);
        expect(await dist.unlockScheduleCount.call()).to.be.bignumber.equal('2');
      });
    });
  });

  describe('unlockTokens', function () {
    describe('single schedule', function () {
      describe('after waiting for 1/2 the duration', function () {
        const timeController = new TimeController();
        beforeEach(async function () {
          await stakingToken.approve(dist.address, $TOKEN(100), { from: owner });
          await dist.lockTokens($TOKEN(100), ONE_YEAR, { from: owner });
          await timeController.initialize();
          await timeController.advanceTime(ONE_YEAR / 2);
        });

        describe('when supply is unchanged', function () {
          it('should unlock 1/2 the tokens', async function () {
            await timeController.executeEmptyBlock();
            expect(await dist.totalLocked.call()).to.be.bignumber.equal($TOKEN(100));
            expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($TOKEN(0));
            await checkAvailableToUnlock(dist, 50);
          });
          it('should transfer tokens to unlocked pool', async function () {
            await dist.updateAccounting();
            checkTokenAprox(await dist.totalLocked.call(), 50);
            checkTokenAprox(await dist.totalUnlocked.call(), 50);
            await checkAvailableToUnlock(dist, 0);
          });
          it('should log TokensUnlocked and update state', async function () {
            const r = await dist.updateAccounting();
            const l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
            checkTokenAprox(l.args.amount, 50);
            checkTokenAprox(l.args.total, 50);
            const s = await dist.unlockSchedules(0);
            expect(s[0]).to.be.bignumber.equal($TOKEN(100));
            checkSharesAprox(s[1], $TOKEN(50));
          });
        });
      });

      describe('after waiting > the duration', function () {
        beforeEach(async function () {
          await stakingToken.approve(dist.address, $TOKEN(100), { from: owner });
          await dist.lockTokens($TOKEN(100), ONE_YEAR, { from: owner });
          await time.increase(2 * ONE_YEAR);
        });
        it('should unlock all the tokens', async function () {
          await checkAvailableToUnlock(dist, 100);
        });
        it('should transfer tokens to unlocked pool', async function () {
          expect(await dist.totalLocked.call()).to.be.bignumber.equal($TOKEN(100));
          expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($TOKEN(0));
          await dist.updateAccounting();
          expect(await dist.totalLocked.call()).to.be.bignumber.equal($TOKEN(0));
          checkTokenAprox(await dist.totalUnlocked.call(), 100);
          await checkAvailableToUnlock(dist, 0);
        });
        it('should log TokensUnlocked and update state', async function () {
          const r = await dist.updateAccounting();
          const l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
          checkTokenAprox(l.args.amount, 100);
          checkTokenAprox(l.args.total, 0);
          const s = await dist.unlockSchedules(0);
          expect(s[0]).to.be.bignumber.equal($TOKEN(100));
          expect(s[1]).to.be.bignumber.equal($TOKEN(100));
        });
      });

      describe('dust tokens due to division underflow', function () {
        beforeEach(async function () {
          await stakingToken.approve(dist.address, $TOKEN(100), { from: owner });
          await dist.lockTokens($TOKEN(1), 10 * ONE_YEAR, { from: owner });
        });
        it('should unlock all tokens', async function () {
          // 1 stakingToken locked for 10 years. Almost all time passes upto the last minute.
          // 0.999999809 stakingTokens are unlocked.
          // 1 minute passes, Now: all of the rest are unlocked: 191
          // before (#24): only 190 would have been unlocked and 0.000000001 stakingToken would be
          // locked.
          await time.increase(10 * ONE_YEAR - 60);
          const r1 = await dist.updateAccounting();
          const l1 = r1.logs.filter(l => l.event === 'TokensUnlocked')[0];
          await time.increase(65);
          const r2 = await dist.updateAccounting();
          const l2 = r2.logs.filter(l => l.event === 'TokensUnlocked')[0];
          expect(l1.args.amount.add(l2.args.amount)).to.be.bignumber.equal($TOKEN(1));
        });
      });
    });

    describe('multi schedule', function () {
      const timeController = new TimeController();
      beforeEach(async function () {
        await stakingToken.approve(dist.address, $TOKEN(200), { from: owner });
        await dist.lockTokens($TOKEN(100), ONE_YEAR, { from: owner });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 2);
        await dist.lockTokens($TOKEN(100), ONE_YEAR, { from: owner });
        await timeController.advanceTime(ONE_YEAR / 10);
      });
      it('should return the remaining unlock value', async function () {
        await time.advanceBlock();
        expect(await dist.totalLocked.call()).to.be.bignumber.equal($TOKEN(150));
        expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($TOKEN(50));
        // 10 from each schedule for the period of ONE_YEAR / 10

        await checkAvailableToUnlock(dist, 20);
      });
      it('should transfer tokens to unlocked pool', async function () {
        await dist.updateAccounting();
        checkTokenAprox(await dist.totalLocked.call(), 130);
        checkTokenAprox(await dist.totalUnlocked.call(), 70);
        await checkAvailableToUnlock(dist, 0);
      });
      it('should log TokensUnlocked and update state', async function () {
        const r = await dist.updateAccounting();

        const l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
        checkTokenAprox(l.args.amount, 20);
        checkTokenAprox(l.args.total, 130);

        const s1 = await dist.unlockSchedules(0);
        checkSharesAprox(s1[0], $TOKEN(100));
        checkSharesAprox(s1[1], $TOKEN(60));
        const s2 = await dist.unlockSchedules(1);
        checkSharesAprox(s2[0], $TOKEN(100));
        checkSharesAprox(s2[1], $TOKEN(10));
      });
      it('should continue linear the unlock', async function () {
        await dist.updateAccounting();
        await timeController.advanceTime(ONE_YEAR / 5);
        await dist.updateAccounting();

        checkTokenAprox(await dist.totalLocked.call(), 90);
        checkTokenAprox(await dist.totalUnlocked.call(), 110);
        await checkAvailableToUnlock(dist, 0);
        await timeController.advanceTime(ONE_YEAR / 5);
        await dist.updateAccounting();

        checkTokenAprox(await dist.totalLocked.call(), 50);
        checkTokenAprox(await dist.totalUnlocked.call(), 150);
        await checkAvailableToUnlock(dist, 0);
      });
    });
  });

  describe('updateAccounting', function () {
    let _r, _t;
    beforeEach(async function () {
      _r = await dist.updateAccounting.call({ from: owner });
      _t = await time.latest();
      await stakingToken.approve(dist.address, $TOKEN(300), { from: owner });
      await dist.stake($TOKEN(100), [], {from: owner});
      await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
      await time.increase(ONE_YEAR / 2);
      await dist.lockTokens($TOKEN(100), ONE_YEAR, {from: owner});
      await time.increase(ONE_YEAR / 10);
    });

    describe('when user history does exist', async function () {
      it('should return the system state', async function () {
        const r = await dist.updateAccounting.call({ from: owner });
        const t = await time.latest();
        checkTokenAprox(r[0], 130);
        checkTokenAprox(r[1], 70);
        const timeElapsed = t.sub(_t);
        expect(r[2].div($TOKEN(100))).to.be
          .bignumber.above(timeElapsed.sub(new BN(5))).and
          .bignumber.below(timeElapsed.add(new BN(5)));
        expect(r[3].div($TOKEN(100))).to.be
          .bignumber.above(timeElapsed.sub(new BN(5))).and
          .bignumber.below(timeElapsed.add(new BN(5)));
        checkTokenAprox(r[4], 70);
        checkTokenAprox(r[4], 70);
        const delta = new BN(r[5]).sub(new BN(_r[5]));
        expect(delta).to.be
          .bignumber.above(timeElapsed.sub(new BN(1))).and
          .bignumber.below(timeElapsed.add(new BN(1)));
      });
    });

    describe('when user history does not exist', async function () {
      it('should return the system state', async function () {
        const r = await dist.updateAccounting.call({ from: constants.ZERO_ADDRESS });
        const t = await time.latest();
        checkTokenAprox(r[0], 130);
        checkTokenAprox(r[1], 70);
        const timeElapsed = t.sub(_t);
        expect(r[2].div($TOKEN(100))).to.be.bignumber.equal('0');
        expect(r[3].div($TOKEN(100))).to.be
          .bignumber.above(timeElapsed.sub(new BN(5))).and
          .bignumber.below(timeElapsed.add(new BN(5)));
        checkTokenAprox(r[4], 0);
        const delta = new BN(r[5]).sub(new BN(_r[5]));
        expect(delta).to.be
          .bignumber.above(timeElapsed.sub(new BN(1))).and
          .bignumber.below(timeElapsed.add(new BN(1)));
      });
    });
  });
});
