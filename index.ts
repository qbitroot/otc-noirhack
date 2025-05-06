import { getInitialTestAccountsWallets } from '@aztec/accounts/testing';
import { deriveKeys } from '@aztec/aztec.js';
import { computePartialAddress } from '@aztec/stdlib/contract';
import {
  EthAddress,
  Fr, GrumpkinScalar,
  Point, AztecAddress,
  L1TokenManager,
  L1TokenPortalManager,
  createLogger,
  createPXEClient,
  waitForPXE,
  computeInnerAuthWitHash,
} from '@aztec/aztec.js';
import { createL1Clients, deployL1Contract } from '@aztec/ethereum';
import {
  FeeAssetHandlerAbi,
  FeeAssetHandlerBytecode,
  TestERC20Abi,
  TestERC20Bytecode,
  TokenPortalAbi,
  TokenPortalBytecode,
} from '@aztec/l1-artifacts';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge';
import { pSymmContract } from './contracts/psymm/src/artifacts/pSymm';

import { getContract } from 'viem';

// --- Utility functions ---
const MNEMONIC = 'test test test test test test test test test test test junk';
const { ETHEREUM_HOSTS = 'http://localhost:8545' } = process.env;

const { walletClient, publicClient } = createL1Clients(ETHEREUM_HOSTS.split(','), MNEMONIC);
const ownerEthAddress = walletClient.account.address;

const MINT_AMOUNT = BigInt(1e12);

const setupSandbox = async () => {
  const { PXE_URL = 'http://localhost:8080' } = process.env;
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const pxe = await createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  return pxe;
};

async function deployTestERC20(): Promise<EthAddress> {
  const constructorArgs = ['Test Token', 'TEST', walletClient.account.address];

  return await deployL1Contract(walletClient, publicClient, TestERC20Abi, TestERC20Bytecode, constructorArgs).then(
    ({ address }) => address,
  );
}

async function deployFeeAssetHandler(l1TokenContract: EthAddress): Promise<EthAddress> {
  const constructorArgs = [walletClient.account.address, l1TokenContract.toString(), MINT_AMOUNT];
  return await deployL1Contract(
    walletClient,
    publicClient,
    FeeAssetHandlerAbi,
    FeeAssetHandlerBytecode,
    constructorArgs,
  ).then(({ address }) => address);
}

async function deployTokenPortal(): Promise<EthAddress> {
  return await deployL1Contract(walletClient, publicClient, TokenPortalAbi, TokenPortalBytecode, []).then(
    ({ address }) => address,
  );
}

async function addMinter(l1TokenContract: EthAddress, l1TokenHandler: EthAddress) {
  const contract = getContract({
    address: l1TokenContract.toString(),
    abi: TestERC20Abi,
    client: walletClient,
  });
  await contract.write.addMinter([l1TokenHandler.toString()]);
}

// --- Main script ---
async function main() {
  const logger = createLogger('psymm');
  const pxe = await setupSandbox();
  const wallets = await getInitialTestAccountsWallets(pxe);
  const ownerWallet = wallets[0];
  const secondWallet = wallets[1];
  const ownerAztecAddress = wallets[0].getAddress();
  const secondAztecAddress = wallets[1].getAddress();
  const l1ContractAddresses = (await pxe.getNodeInfo()).l1ContractAddresses;
  logger.info('L1 Contract Addresses:');
  logger.info(`Registry Address: ${l1ContractAddresses.registryAddress}`);
  logger.info(`Inbox Address: ${l1ContractAddresses.inboxAddress}`);
  logger.info(`Outbox Address: ${l1ContractAddresses.outboxAddress}`);
  logger.info(`Rollup Address: ${l1ContractAddresses.rollupAddress}`);
  logger.info(`Address 1: ${ownerAztecAddress}`);
  logger.info(`Address 2: ${secondAztecAddress}`);

  // Deploy L2 token contract
  const l2TokenContract = await TokenContract.deploy(ownerWallet, ownerAztecAddress, 'L2 Token', 'L2', 18)
    .send()
    .deployed();
  logger.info(`L2 token contract deployed at ${l2TokenContract.address}`);

  const psymmDeployment = await pSymmContract.deploy(
    ownerWallet,
    l2TokenContract.address
  );
  const psymmContract = await psymmDeployment.send().deployed();
  // pxe.registerSender(psymmContract.address);

  logger.info(`pSymm contract deployed at ${psymmContract.address}`);
  
  // Deploy L1 token contract and setup L1TokenManager
  const l1TokenContract = await deployTestERC20();
  logger.info('erc20 contract deployed');

  const feeAssetHandler = await deployFeeAssetHandler(l1TokenContract);
  await addMinter(l1TokenContract, feeAssetHandler);

  const l1TokenManager = new L1TokenManager(l1TokenContract, feeAssetHandler, publicClient, walletClient, logger);

  // Deploy L1 portal contract
  const l1PortalContractAddress = await deployTokenPortal();
  logger.info('L1 portal contract deployed');

  const l1Portal = getContract({
    address: l1PortalContractAddress.toString(),
    abi: TokenPortalAbi,
    client: walletClient,
  });

  // Deploy L2 bridge contract
  const l2BridgeContract = await TokenBridgeContract.deploy(
    ownerWallet,
    l2TokenContract.address,
    l1PortalContractAddress,
  )
    .send()
    .deployed();
  logger.info(`L2 token bridge contract deployed at ${l2BridgeContract.address}`);

  // Authorize L2 bridge contract to mint tokens on L2 token contract
  await l2TokenContract.methods.set_minter(l2BridgeContract.address, true).send().wait();
  logger.info('L2 bridge authorized to mint on L2 token');

  // Setup L1 portal contract and L1TokenPortalManager
  await l1Portal.write.initialize(
    [l1ContractAddresses.registryAddress.toString(), l1TokenContract.toString(), l2BridgeContract.address.toString()],
    {},
  );
  logger.info('L1 portal contract initialized');

  const l1PortalManager = new L1TokenPortalManager(
    l1PortalContractAddress,
    l1TokenContract,
    feeAssetHandler,
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
  const custodyId = 123n;
  const transferNonce = Fr.random();
  const counterparties = [secondAztecAddress, AztecAddress.ZERO, AztecAddress.ZERO, AztecAddress.ZERO];
  
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
    .address_to_custody(ownerAztecAddress, counterparties, custodyId, transferAmount, transferNonce)
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
  const withdrawNonce = 8888n;

  // Get approval from counterparty first
  await psymmContract.withWallet(secondWallet).methods
    .approve_withdrawal(ownerAztecAddress, custodyId, withdrawAmount, withdrawNonce)
    .send()
    .wait();
  logger.info(`Counterparty approved withdrawal of ${withdrawAmount} tokens`);

  // Now execute the withdrawal with approval
  await psymmContract.withWallet(ownerWallet).methods
    .custody_to_address(ownerAztecAddress, counterparties, custodyId, withdrawAmount, withdrawNonce)
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
  const l1WithdrawAmount = 9n;
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
