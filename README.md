# pSymm

pSymm -- private & symmetric OTC derivatives trading project. The idea is to allow two parties trade any asset in a trustless, permissionless, decentralized way. The high-level architecture of the platform:

- pSymm: Aztec Noir L2 contract integrating TokenPortal.nr and SettleMaker.sol for both happy and disputed trading sessions.
- Offchain infra: web UI utilizing MetaMask and Aztec PXE.
- SettleMaker: a dispute resolution contract. Uses validators, staking, slashing mechanism for voting on disputed trading sessions. To dispute a session, parties must reveal their trading activity.

This project will be a part of [Symmio](https://www.symm.io/), bringing Aztec privacy to the existing platform.

The high-level flow is like this:

1.  **Discovery:** Trader finds a Solver using a PartyRegistry.sol contract (publicly writable IP storage).
2.  **Connection:** Trader connects to the Solver's websocket endpoint.
3.  **Logon & Collateralization:**
    - Trader makes an onchain deposit through TokenPortal and sends a Logon message (including the deposit proof) to the Solver.
    - Solver verifies the Trader's deposit, makes their own deposit (creating their commitment), and sends a Logon message back.
4.  **Trading:**
    - Trader sends quote requests and orders; Solver quotes and fills.
    - All trading messages are signed sequentially, with each message containing a hash of all previous messages and the sender's ECDSA signature. These messages remain private between the parties unless a dispute arises.
5.  **Withdrawal/Settlement:**
    - **No Dispute:** The party owing PnL uses the CTC circuit to split their collateral commitment into two: one for the PnL amount and one for the remaining collateral. They privately send the secret data for the PnL commitment to the counterparty. Both parties can then withdraw their respective funds (original collateral +/- PnL) using the CTA circuit.
    - **Dispute:** One party initiates a dispute by revealing the entire signed message history to the SettleMaker contract. Validators review the session based on predefined rules and vote. The party found at fault is slashed.

## Setup

Install dependencies:

```
yarn && cd web-demo && yarn

```

To test the project, run [Aztec Sandbox](https://aztec.network/sandbox):

```
aztec start --sandbox
```

To launch web UI:

```
cd web-demo && yarn vite
```

Don't forget to add some local Hardhat ETH to your MetaMask address:

```
node web-demo/mint.js 0x123youraddress
```

(Optional) Test the flow in the terminal:

```
yarn deploy
yarn test
```

## Work done during NoirHack

Initially pSymm was made with Solidity + Noir circuits, then was remade from scratch during NoirHack to use Aztec blockchain.

_Note: SettleMaker <> pSymm communication is WIP. The idea is to use inbox to consume SettleMaker message on L2 on withdraw._
