const { BN } = require('@openzeppelin/test-helpers');
const { promisify } = require('util');
const { time } = require('@openzeppelin/test-helpers');
const { web3 } = require('@openzeppelin/test-environment');
const { expect } = require('chai');

const TOKEN_DECIMALS = 18;

// check for 1% lp tax
function $TOKEN (x, fee = 0) {
  if(fee != 0){
    var feeVal = 100 * (x - (fee / 100))
    return (new BN(feeVal)).mul((new BN(10)).pow(new BN(TOKEN_DECIMALS - 2)))
  }

  return (new BN(x)).mul((new BN(10)).pow(new BN(TOKEN_DECIMALS)))
}

function checkTokenAprox (x, y, fee=0) {
  checkAprox(x, $TOKEN(y, fee), TOKEN_DECIMALS);
}

function checkSharesAprox (x, y) {
  checkAprox(x, y, TOKEN_DECIMALS);
}

function checkAprox (x, y, delta_) {
  const delta = (new BN(10)).pow(new BN(delta_))
  const upper = y.add(delta);
  const lower = y.sub(delta);
  expect(x).to.be.bignumber.at.least(lower).and.bignumber.at.most(upper);
}

class TimeController {
  async initialize () {
    this.currentTime = await time.latest();
  }
  async advanceTime (seconds) {
    await time.increase(seconds)
  }

  async executeEmptyBlock () {
    await time.advanceBlock();
  }
}

async function printMethodOutput (r) {
  console.log(r.logs);
}

async function printStatus (dist) {
  console.log('Total Locked: ', await dist.totalLocked.call().toString());
  console.log('Total UnLocked: ', await dist.totalUnlocked.call().toString());
  const c = (await dist.unlockScheduleCount.call()).toNumber();
  console.log(await dist.unlockScheduleCount.call().toString());

  for (let i = 0; i < c; i++) {
    console.log(await dist.unlockSchedules.call(i).toString());
  }
}


module.exports = {checkTokenAprox, checkSharesAprox, $TOKEN, TimeController, printMethodOutput, printStatus};
