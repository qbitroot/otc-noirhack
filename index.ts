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

import { getContract } from 'viem';

// --- Utility functions ---
const MNEMONIC = 'test test test test test test test test test test test junk';
const { ETHEREUM_HOSTS = 'http://localhost:8545' } = process.env;

const { walletClient, publicClient } = createL1Clients(ETHEREUM_HOSTS.split(','), MNEMONIC);
const ownerEthAddress = walletClient.account.address;

const MINT_AMOUNT = BigInt(1e15);

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
  const logger = createLogger('aztec:token-bridge-tutorial');
  const pxe = await setupSandbox();
  const wallets = await getInitialTestAccountsWallets(pxe);
  const ownerWallet = wallets[0];
  const ownerAztecAddress = wallets[0].getAddress();
  const l1ContractAddresses = (await pxe.getNodeInfo()).l1ContractAddresses;
  logger.info('L1 Contract Addresses:');
  logger.info(`Registry Address: ${l1ContractAddresses.registryAddress}`);
  logger.info(`Inbox Address: ${l1ContractAddresses.inboxAddress}`);
  logger.info(`Outbox Address: ${l1ContractAddresses.outboxAddress}`);
  logger.info(`Rollup Address: ${l1ContractAddresses.rollupAddress}`);

  // Deploy L2 token contract
  const l2TokenContract = await TokenContract.deploy(ownerWallet, ownerAztecAddress, 'L2 Token', 'L2', 18)
    .send()
    .deployed();
  logger.info(`L2 token contract deployed at ${l2TokenContract.address}`);

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

  // Bridge tokens from L1 to L2 (publicly)
  const claim = await l1PortalManager.bridgeTokensPublic(ownerAztecAddress, MINT_AMOUNT, true);
  logger.info(`Tokens bridged from L1 to L2`);

  // Do 2 unrelated actions because
  // https://github.com/AztecProtocol/aztec-packages/blob/7e9e2681e314145237f95f79ffdc95ad25a0e319/yarn-project/end-to-end/src/shared/cross_chain_test_harness.ts#L354-L355
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
  logger.info('Sent 2 dummy txs to advance L1->L2 message processing');

  // Claim tokens on Aztec (L2)
  await l2BridgeContract.methods
    .claim_public(ownerAztecAddress, MINT_AMOUNT, claim.claimSecret, claim.messageLeafIndex)
    .send()
    .wait();
  const balance = await l2TokenContract.methods.balance_of_public(ownerAztecAddress).simulate();
  logger.info(`Public L2 balance of ${ownerAztecAddress} is ${balance}`);

  // Setup withdrawal
  const withdrawAmount = 9n;
  const nonce = Fr.random();

  // Give approval to bridge to burn owner's funds:
  const authwit = await ownerWallet.setPublicAuthWit(
    {
      caller: l2BridgeContract.address,
      action: l2TokenContract.methods.burn_public(ownerAztecAddress, withdrawAmount, nonce),
    },
    true,
  );
  await authwit.send().wait();
  logger.info('Public authwit set for L2 withdrawal burn');

  // Start withdrawal process on Aztec (L2)
  const l2ToL1Message = await l1PortalManager.getL2ToL1MessageLeaf(
    withdrawAmount,
    EthAddress.fromString(ownerEthAddress),
    l2BridgeContract.address,
    EthAddress.ZERO,
  );
  const l2TxReceipt = await l2BridgeContract.methods
    .exit_to_l1_public(EthAddress.fromString(ownerEthAddress), withdrawAmount, EthAddress.ZERO, nonce)
    .send()
    .wait();
  logger.info('Withdrawal initiated on L2');

  const newL2Balance = await l2TokenContract.methods.balance_of_public(ownerAztecAddress).simulate();
  logger.info(`New L2 balance of ${ownerAztecAddress} is ${newL2Balance}`);

  // Complete withdrawal process on L1
  const [l2ToL1MessageIndex, siblingPath] = await pxe.getL2ToL1MembershipWitness(
    await pxe.getBlockNumber(),
    l2ToL1Message,
  );
  await l1PortalManager.withdrawFunds(
    withdrawAmount,
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
