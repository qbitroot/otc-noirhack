# pSymm

pSymm -- private & symmetric OTC derivatives trading project. The idea is to allow two parties trade any asset in a trustless, permissionless, decentralized way. The high-level architecture of the platform:

- pSymm: the contract holding collaterals of parties, managing their funds using Noir circuits. It facilitates private deposits, internal transfers, and withdrawals.
- SettleMaker: a dispute resolution contract, using validators, staking, slashing for voting on disputed trading sessions. To dispute a session, parties must reveal their trading activity.
- Offchain infra: client UI with Metamask integration, a counterparty (Solver), etc.

For NoirHack the focus is on business logic of pSymm. The high-level flow is like this:

1.  **Discovery:** Trader finds a Solver via an onchain Party Registry.
2.  **Connection:** Trader connects to the Solver's websocket endpoint.
3.  **Logon & Collateralization:**
    - Trader makes an onchain deposit (creating a commitment) and sends a Logon message (including the deposit proof) to the Solver.
    - Solver verifies the Trader's deposit, makes their own deposit (creating their commitment), and sends a Logon message back.
4.  **Trading:**
    - Trader sends quote requests and orders; Solver quotes and fills.
    - All trading messages are signed sequentially, with each message containing a hash of all previous messages and the sender's ECDSA signature. These messages remain private between the parties unless a dispute arises.
5.  **Withdrawal/Settlement:**
    - **No Dispute:** The party owing PnL uses the CTC circuit to split their collateral commitment into two: one for the PnL amount and one for the remaining collateral. They privately send the secret data for the PnL commitment to the counterparty. Both parties can then withdraw their respective funds (original collateral +/- PnL) using the CTA circuit.
    - **Dispute:** One party initiates a dispute by revealing the entire signed message history to the SettleMaker contract. Validators review the session based on predefined rules and vote. The party found at fault is slashed.

## Circuits

The core privacy feature relies on SNARKs (via Noir circuits) to verify knowledge of secrets for commitments without revealing the link between deposits (commitments) and withdrawals (nullifiers).

- **ATC (address to custody):** Deposit funds to pSymm. Creates an onchain commitment corresponding to the deposited funds, proving the commitment matches the deposited amount without revealing the link publicly later.
- **CTC (custody to custody):** Split a commitment into two new commitments. This allows users to anonymize funds by breaking the link to the original deposit address and amount. It verifies that the sum of the new commitments equals the original one. This circuit is crucial for both enhancing privacy and enabling the PnL rebalance at the end of a trading session without disputes.
- **CTA (custody to address):** Withdraw funds from pSymm using a nullifier derived from the commitment's secret. This prevents double-spending. A timelock is included to prevent a party from maliciously withdrawing collateral immediately after a trade turns unprofitable.

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
