# pSymm

pSymm -- private & symmetric OTC derivatives trading project. The idea is to allow two parties trade any asset in a trustless, permissionless, decentralized way. The high-level architecture of the platform:

- pSymm: the contract holding collaterals of parties, managing their funds using Noir circuits.
- SettleMaker: a dispute resolution contract, using validators, staking, slashing for voting on disputed trading sessions. To dispute a session, parties must reveal their trading activity.
- Offchain infra: client UI with Metamask integration, a counterparty, etc.

For NoirHack the focus is on business logic of pSymm. The high-level flow is like this:

TODO: elaborate.

## Circuits

- ATC (address to custody) - deposit funds to pSymm.
- CTC (custody to custody) - split/anonymize funds between pSymm custodies (without disclosing original commitment)
  - TODO: fix mismatch of merkle tree root between Noir and Solidity
- TODO: withdraw, PnL rebalance

## Installation

1. Install JavaScript dependencies:

   ```bash
   yarn install
   ```

2. Install Noir and the Barretenberg (BB) proving backend by following [official documentation](https://noir-lang.org/docs/getting_started/quick_start).

## Testing

Run the test suite with:

```bash
yarn hardhat test contracts/test/noirPsymm
```
