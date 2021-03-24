# LP Staking Pool

A smart-contract based mechanism to distribute tokens over time, forked and modified from AMPL's Token Geyser.

Adds a 1% liquidity tax on withdrawal. The liquidity tax is sent to the contract address, and is locked forever.

AddTokens function added to allow for token fees to accumulate into current vesting contracts while maintaining stable apy.

The official staking pool contract addresses are:
- UniswapV2 [ETH/VOICE]() Pool: [0xebd6b49a889dfb1ad3a141cf98d8f61d182975f0](https://etherscan.io/address/0xebd6b49a889dfb1ad3a141cf98d8f61d182975f0)
- UniswapV2 [ETH/MUTE]() Pool: [0x3ba273e7532c526662e383e6635933ce12e14049](https://etherscan.io/address/0x3ba273e7532c526662e383e6635933ce12e14049)

## Table of Contents

- [Install](#install)
- [Testing](#testing)
- [Contribute](#contribute)
- [License](#license)


## Install

```bash
# Install project dependencies
npm install

# Install ethereum local blockchain(s) and associated dependencies
npx setup-local-chains
```

## Testing

``` bash
# Run all unit tests
npm test
```

## Contribute

To report bugs within this package, please create an issue in this repository.
When submitting code ensure that it is free of lint errors and has 100% test coverage.

## License

[GNU General Public License v3.0 (c) 2021 mute.io](./LICENSE)
[GNU General Public License v3.0 (c) 2020 Fragments, Inc.](./LICENSE)
