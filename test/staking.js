const { contract, accounts } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, BN, constants } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;
const { $TOKEN } = _require('/test/helper');

const MockERC20 = contract.fromArtifact('MockERC20');
const TokenGeyser = contract.fromArtifact('TokenGeyser');

let stakingToken, dist, owner, anotherAccount;
describe('staking', function () {
  beforeEach('setup contracts', async function () {
    const [_owner, user1] =  accounts;

    owner = _owner;
    anotherAccount = user1;

    stakingToken = await MockERC20.new($TOKEN(50000), {from: owner});

    const startBonus = 50;
    const bonusPeriod = 86400;
    dist = await TokenGeyser.new(stakingToken.address, stakingToken.address, startBonus, bonusPeriod, {from: owner});
  });

  describe('getStakingToken', function () {
    it('should return the staking token', async function () {
      expect(await dist.getStakingToken.call()).to.equal(stakingToken.address);
    });
  });

  describe('token', function () {
    it('should return the staking token', async function () {
      expect(await dist.token.call()).to.equal(stakingToken.address);
    });
  });

  describe('stake', function () {
    describe('when the amount is 0', function () {
      it('should fail', async function () {
        await stakingToken.approve(dist.address, $TOKEN(1000), { from: owner });
        await expectRevert.unspecified(dist.stake($TOKEN(0), [], { from: owner }));
      });
    });

    describe('when token transfer has not been approved', function () {
      it('should fail', async function () {
        await stakingToken.approve(dist.address, $TOKEN(10), {from: owner});
        await expectRevert.unspecified(dist.stake($TOKEN(100), [], { from: owner }));
      });
    });

    describe('when totalStaked=0', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(0));
        await stakingToken.approve(dist.address, $TOKEN(100), {from: owner});
      });
      it('should updated the total staked', async function () {
        await dist.stake($TOKEN(100), [], { from: owner });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(100));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(100));
        expect(await dist.totalStakingTokens.call()).to.be.bignumber.equal($TOKEN(100));
      });
      it('should log Staked', async function () {
        const r = await dist.stake($TOKEN(100), [], { from: owner });
        expectEvent(r, 'Staked', {
          user: owner,
          amount: $TOKEN(100),
          total: $TOKEN(100)
        });
      });
    });

    describe('when totalStaked>0', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(0));
        await stakingToken.transfer(anotherAccount, $TOKEN(50), {from: owner});
        await stakingToken.approve(dist.address, $TOKEN(50), { from: anotherAccount });
        await dist.stake($TOKEN(50), [], { from: anotherAccount });
        await stakingToken.approve(dist.address, $TOKEN(150), { from: owner });
        await dist.stake($TOKEN(150), [], { from: owner });
      });
      it('should updated the total staked', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($TOKEN(200));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($TOKEN(50));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($TOKEN(150));
        expect(await dist.totalStakingTokens.call()).to.be.bignumber.equal($TOKEN(200));
      });
    });
  });

});


describe('rescueFundsFromStakingPool', function () {
  describe('when tokens gets air-dropped', function() {
    it('should allow the owner to claim them', async function() {
      const [_owner, user1] =  accounts;

      owner = (_owner);
      anotherAccount = (user1);

      stakingToken = await MockERC20.new($TOKEN(50000), {from: owner});


      const startBonus = 50;
      const bonusPeriod = 86400;
      const dist = await TokenGeyser.new(stakingToken.address, stakingToken.address, startBonus, bonusPeriod, { from: owner });

      await stakingToken.approve(dist.address, $TOKEN(100), { from: owner });
      await dist.stake($TOKEN(100), [], { from: owner });

      const transfers = await stakingToken.contract.getPastEvents('Transfer');
      const transferLog = transfers[transfers.length - 1];
      const stakingPool = transferLog.returnValues.to;

      expect(await stakingToken.balanceOf.call(stakingPool)).to.be.bignumber.equal($TOKEN(100));

      const token = await MockERC20.new(1000);
      await token.transfer(stakingPool, 1000);

      expect(await token.balanceOf.call(anotherAccount)).to.be.bignumber.equal('0');
      await dist.rescueFundsFromStakingPool(
        token.address, anotherAccount, 1000, { from: owner }
      );
      expect(await token.balanceOf.call(anotherAccount)).to.be.bignumber.equal('1000');

      await expectRevert(
        dist.rescueFundsFromStakingPool(stakingToken.address, anotherAccount, $TOKEN(10), { from: owner }),
        'TokenPool: Cannot claim token held by the contract'
      );

      expect(await stakingToken.balanceOf.call(stakingPool)).to.be.bignumber.equal($TOKEN(100));
    })
  });
});
