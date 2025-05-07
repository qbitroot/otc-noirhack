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
const MINT_AMOUNT = BigInt(1e4);

const { walletClient, publicClient } = createL1Clients(ETHEREUM_HOSTS.split(','), MNEMONIC);
const ownerEthAddress = walletClient.account.address;

const setupSandbox = async () => {
  const { PXE_URL = 'http://localhost:8080' } = process.env;
  const pxe = await createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  return pxe;
};
async function main() {
  // Read deployed contract addresses
  const contracts = JSON.parse(fs.readFileSync('contracts.json', 'utf8'));
  
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

  // Bridge tokens from L1 to L2 (privately)
  const claim = await l1PortalManager.bridgeTokensPrivate(ownerAztecAddress, MINT_AMOUNT, true);
  logger.info(`Tokens bridged from L1 to L2`);

  // Do 2 unrelated actions because
  // https://github.com/AztecProtocol/aztec-packages/blob/7e9e2681e314145237f95f79ffdc95ad25a0e319/yarn-project/end-to-end/src/shared/cross_chain_test_harness.ts#L354-L355
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  logger.info('Sent 2 dummy txs to advance L1->L2 message processing');

  // Claim tokens on Aztec (L2)
  await l2BridgeContract.methods
    .claim_private(ownerAztecAddress, MINT_AMOUNT, claim.claimSecret, claim.messageLeafIndex)
    .send()
    .wait();
  const balance = await l2TokenContract.methods.balance_of_private(ownerAztecAddress).simulate();
  logger.info(`Private L2 balance of ${ownerAztecAddress} is ${balance}`);

  // Get contract config
  const config = await psymmContract.methods.get_config().simulate();
  logger.info(`pSymm config: token address = ${config.token}`);

  // Transfer tokens to custody ID 0 privately
  const transferAmount = BigInt(100);
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
      action: l2TokenContract.methods.transfer_to_public(ownerAztecAddress, psymmContract.address, transferAmount, transferNonce),
    },
  );
  logger.info('Private authwit created for L2 transfer');
  
  // Transfer to custody ID with authwit
  await psymmContract.methods
    .address_to_custody(custodyId, parties, 0, transferAmount, transferNonce)
    .send({ authWitnesses: [authwitTransfer] })
    .wait();
  logger.info(`Transferred ${transferAmount} tokens to custody ID ${custodyId} privately`);

  // Check custody balance after transfer from owner's perspective
  const custodyBalance = await psymmContract.methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from owner's view is ${custodyBalance}`);
  const custodyBalance2 = await psymmContract.withWallet(secondWallet).methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from second user's view is ${custodyBalance2}`);

  // Transfer tokens from custody ID 0 back to address
  const withdrawAmount = BigInt(50);
  const withdrawNonce = Fr.random();

  // Get approval from counterparty first
  await psymmContract.withWallet(secondWallet).methods
    .approve_withdrawal(ownerAztecAddress, custodyId, withdrawAmount, withdrawNonce)
    .send()
    .wait();
  logger.info(`Counterparty approved withdrawal of ${withdrawAmount} tokens`);

  // Now execute the withdrawal with approval
  await psymmContract.withWallet(ownerWallet).methods
    .custody_to_address(custodyId, parties, 0, withdrawAmount, withdrawNonce)
    .send()
    .wait();
  logger.info(`Transferred ${withdrawAmount} tokens from custody ID ${custodyId} to address`);
  
  // Check final balances
  const finalCustodyBalance = await psymmContract.methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from owner's view is ${finalCustodyBalance}`);
  const finalCustodyBalance2 = await psymmContract.withWallet(secondWallet).methods.custody_balance(custodyId, ownerAztecAddress).simulate();
  logger.info(`Custody balance for ID ${custodyId} from second user's view is ${finalCustodyBalance2}`);

  // Check balances from second wallet's perspective for both addresses
  const ownerBalanceFromSecond = await psymmContract.withWallet(secondWallet).methods.custody_balance_from(custodyId, ownerAztecAddress).simulate();
  logger.info(`Owner's custody balance for ID ${custodyId} viewed from second wallet: ${ownerBalanceFromSecond}`);
  
  const secondBalanceFromSecond = await psymmContract.withWallet(secondWallet).methods.custody_balance_from(custodyId, secondAztecAddress).simulate();
  logger.info(`Second wallet's custody balance for ID ${custodyId} viewed from second wallet: ${secondBalanceFromSecond}`);

  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  logger.info('Sent 2 dummy txs to advance L1->L2 message processing');


  // Setup withdrawal to L1
  const l1WithdrawAmount = 50n;
  const nonce = Fr.random();

  // Create private authwit for withdrawal
  const authwit = await ownerWallet.createAuthWit(
    {
      caller: l2BridgeContract.address,
      action: l2TokenContract.methods.burn_private(ownerAztecAddress, l1WithdrawAmount, nonce),
    },
  );
  logger.info('Private authwit created for L2 withdrawal burn');

  // Start withdrawal process on Aztec (L2)
  const l2ToL1Message = await l1PortalManager.getL2ToL1MessageLeaf(
    l1WithdrawAmount,
    EthAddress.fromString(ownerEthAddress),
    l2BridgeContract.address,
    EthAddress.ZERO,
  );
  const l2TxReceipt = await l2BridgeContract.methods
    .exit_to_l1_private(l2TokenContract.address, EthAddress.fromString(ownerEthAddress), l1WithdrawAmount, EthAddress.ZERO, nonce)
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
    l1WithdrawAmount,
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
