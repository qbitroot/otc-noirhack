import { getInitialTestAccountsWallets } from '@aztec/accounts/testing';
import {
  EthAddress,
  Fr,
  L1TokenManager,
  L1TokenPortalManager,
  createLogger,
  createPXEClient,
  waitForPXE,
} from '@aztec/aztec.js';
import { createL1Clients } from '@aztec/ethereum';
import { TestERC20Abi, TokenPortalAbi } from '@aztec/l1-artifacts';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge';
import { pSymmContract } from './contracts/psymm/src/artifacts/pSymm';
import { getContract } from 'viem';
import * as fs from 'fs';

const MNEMONIC = 'test test test test test test test test test test test junk';
const { ETHEREUM_HOSTS = 'http://localhost:8545' } = process.env;
const MINT_AMOUNT = BigInt(100 * 10**18); // Amount per party
const TRANSFER_AMOUNT_TO_CUSTODY = BigInt(100 * 10**18);
const WITHDRAW_AMOUNT_FROM_CUSTODY = BigInt(125 * 10**18);
const L1_WITHDRAW_AMOUNT = BigInt(125 * 10**18);

const MINT_AMOUNT = BigInt(100 * 10**18); // Amount per party
const TRANSFER_AMOUNT_TO_CUSTODY = BigInt(100 * 10**18);
const WITHDRAW_AMOUNT_FROM_CUSTODY = BigInt(125 * 10**18);
const L1_WITHDRAW_AMOUNT = BigInt(125 * 10**18);

const { walletClient, publicClient } = createL1Clients(ETHEREUM_HOSTS.split(','), MNEMONIC);
const ownerEthAddress = walletClient.account.address;

const setupSandbox = async () => {
  const { PXE_URL = 'http://localhost:8080' } = process.env;
  const pxe = await createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  return pxe;
};
async function main() {
  // Read deployed contract addresses from web-demo/public
  const contracts = JSON.parse(fs.readFileSync('./web-demo/public/contracts.json', 'utf8'));
  
  const logger = createLogger('psymm');
  const pxe = await setupSandbox();
  const wallets = await getInitialTestAccountsWallets(pxe);
  const ownerWallet = wallets[0];
  const secondWallet = wallets[1];
  const ownerAztecAddress = wallets[0].getAddress();
  const secondAztecAddress = wallets[1].getAddress();
  const l1ContractAddresses = (await pxe.getNodeInfo()).l1ContractAddresses;

  // Initialize contract instances
  const l2TokenContract = await TokenContract.at(contracts.l2Token, ownerWallet);
  const psymmContract = await pSymmContract.at(contracts.psymm, ownerWallet);
  const l2BridgeContract = await TokenBridgeContract.at(contracts.l2Bridge, ownerWallet);

  const l1TokenManager = new L1TokenManager(
    EthAddress.fromString(contracts.l1Token),
    EthAddress.fromString(contracts.feeAssetHandler),
    publicClient,
    walletClient,
    logger
  );

  const l1PortalManager = new L1TokenPortalManager(
    EthAddress.fromString(contracts.l1Portal),
    EthAddress.fromString(contracts.l1Token),
    EthAddress.fromString(contracts.feeAssetHandler),
    l1ContractAddresses.outboxAddress,
    publicClient,
    walletClient,
    logger,
  );

  // Bridge tokens from L1 to L2 (privately) for both parties
  const claims = {
    owner: await l1PortalManager.bridgeTokensPrivate(ownerAztecAddress, MINT_AMOUNT, true),
    second: await l1PortalManager.bridgeTokensPrivate(secondAztecAddress, MINT_AMOUNT, true)
  };
  logger.info(`Tokens bridged from L1 to L2 for both parties`);

  // Do 2 unrelated actions to advance L1->L2 messages
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  logger.info('Sent 2 dummy txs to advance L1->L2 message processing');

  // Claim tokens on Aztec (L2) for both parties
  await l2BridgeContract.methods
    .claim_private(ownerAztecAddress, MINT_AMOUNT, claims.owner.claimSecret, claims.owner.messageLeafIndex)
    .send()
    .wait();
  await l2BridgeContract.methods
    .claim_private(secondAztecAddress, MINT_AMOUNT, claims.second.claimSecret, claims.second.messageLeafIndex)
    .send()
    .wait();
    
  const ownerBalance = await l2TokenContract.methods.balance_of_private(ownerAztecAddress).simulate();
  const secondBalance = await l2TokenContract.methods.balance_of_private(secondAztecAddress).simulate();
  logger.info(`Private L2 balance of owner ${ownerAztecAddress} is ${ownerBalance}`);
  logger.info(`Private L2 balance of second ${secondAztecAddress} is ${secondBalance}`);

  // Get contract config
  const config = await psymmContract.methods.get_config().simulate();
  logger.info(`pSymm config: token address = ${config.token}`);

  // Import poseidon2Hash dynamically
  const { poseidon2Hash } = await import("@zkpassport/poseidon2");

  // Generate custody ID from parties using poseidon hash
  const parties = [ownerAztecAddress, secondAztecAddress];
  const partyFields = parties.map(addr => BigInt(addr.toString()));
  const custodyId = poseidon2Hash(partyFields);
  const transferNonce = Fr.random();
  
  // Create private authwit for transfer
  const authwitTransfer = await ownerWallet.createAuthWit(
    {
      caller: psymmContract.address,
      action: l2TokenContract.methods.transfer_to_public(ownerAztecAddress, psymmContract.address, TRANSFER_AMOUNT_TO_CUSTODY, transferNonce),
    },
  );
  logger.info('Private authwit created for L2 transfer');
  
  // Transfer to custody ID with authwit for both parties
  await psymmContract.methods
    .address_to_custody(custodyId, parties, 0, TRANSFER_AMOUNT_TO_CUSTODY, transferNonce)
    .send({ authWitnesses: [authwitTransfer] })
    .wait();
  logger.info(`Owner transferred ${TRANSFER_AMOUNT_TO_CUSTODY} tokens to custody ID ${custodyId} privately`);

  // Create authwit for second party's transfer
  const secondAuthwitTransfer = await secondWallet.createAuthWit(
    {
      caller: psymmContract.address,
      action: l2TokenContract.methods.transfer_to_public(secondAztecAddress, psymmContract.address, TRANSFER_AMOUNT_TO_CUSTODY, transferNonce),
    },
  );
  
  // Second party transfers to custody
  await psymmContract.withWallet(secondWallet).methods
    .address_to_custody(custodyId, parties, 1, TRANSFER_AMOUNT_TO_CUSTODY, transferNonce)
    .send({ authWitnesses: [secondAuthwitTransfer] })
    .wait();
  logger.info(`Second party transferred ${TRANSFER_AMOUNT_TO_CUSTODY} tokens to custody ID ${custodyId} privately`);

  // Check custody balance after transfer from owner's perspective
  const custodyBalance = await psymmContract.methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from owner's view is ${custodyBalance}`);
  const custodyBalance2 = await psymmContract.withWallet(secondWallet).methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from second user's view is ${custodyBalance2}`);

  // Transfer tokens from custody ID back to address
  const withdrawNonce = Fr.random();

  // Get approval from counterparty first
  await psymmContract.withWallet(secondWallet).methods
    .approve_withdrawal(ownerAztecAddress, custodyId, WITHDRAW_AMOUNT_FROM_CUSTODY, withdrawNonce)
    .send()
    .wait();
  logger.info(`Counterparty approved withdrawal of ${WITHDRAW_AMOUNT_FROM_CUSTODY} tokens`);

  // Now execute the withdrawal with approval
  await psymmContract.withWallet(ownerWallet).methods
    .custody_to_address(custodyId, parties, 0, WITHDRAW_AMOUNT_FROM_CUSTODY, withdrawNonce)
    .send()
    .wait();
  logger.info(`Transferred ${WITHDRAW_AMOUNT_FROM_CUSTODY} tokens from custody ID ${custodyId} to address`);
  
  // Check final balances
  const finalCustodyBalance = await psymmContract.methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from owner's view is ${finalCustodyBalance}`);
  const finalCustodyBalance2 = await psymmContract.withWallet(secondWallet).methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from second user's view is ${finalCustodyBalance2}`);

  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  logger.info('Sent 2 dummy txs to advance L1->L2 message processing');


  // First transfer to private balance
  await l2TokenContract.methods.transfer_to_private(ownerAztecAddress, L1_WITHDRAW_AMOUNT).send().wait();
  logger.info('Transferred to private balance before withdrawal');

  // Setup withdrawal to L1
  const nonce = Fr.random();
  
  // Create private authwit for withdrawal
  const authwit = await ownerWallet.createAuthWit(
    {
      caller: l2BridgeContract.address,
      action: l2TokenContract.methods.burn_private(ownerAztecAddress, L1_WITHDRAW_AMOUNT, nonce),
    },
  );
  logger.info('Private authwit created for L2 withdrawal burn');

  // Start withdrawal process on Aztec (L2) 
  const l2ToL1Message = await l1PortalManager.getL2ToL1MessageLeaf(
    L1_WITHDRAW_AMOUNT,
    EthAddress.fromString(ownerEthAddress), 
    l2BridgeContract.address,
    EthAddress.ZERO,
  );
  const l2TxReceipt = await l2BridgeContract.methods
    .exit_to_l1_private(l2TokenContract.address, EthAddress.fromString(ownerEthAddress), L1_WITHDRAW_AMOUNT, EthAddress.ZERO, nonce)
    .send({ authWitnesses: [authwit] })
    .wait();
  logger.info('Withdrawal initiated on L2 privately');

  const newL2Balance = await l2TokenContract.methods.balance_of_private(ownerAztecAddress).simulate();
  logger.info(`New L2 balance of ${ownerAztecAddress} is ${newL2Balance}`);

  // Complete withdrawal process on L1
  const [l2ToL1MessageIndex, siblingPath] = await pxe.getL2ToL1MembershipWitness(
    await pxe.getBlockNumber(),
    l2ToL1Message,
  );
  await l1PortalManager.withdrawFunds(
    L1_WITHDRAW_AMOUNT,
    EthAddress.fromString(ownerEthAddress),
    BigInt(l2TxReceipt.blockNumber!),
    l2ToL1MessageIndex,
    siblingPath,
  );
  logger.info('Withdrawal completed on L1');

  const newL1Balance = await l1TokenManager.getL1TokenBalance(ownerEthAddress);
  logger.info(`New L1 balance of ${ownerEthAddress} is ${newL1Balance}`);
}

main().catch(error => {
  console.error(`Error running script: ${error}`);
  process.exit(1);
});
