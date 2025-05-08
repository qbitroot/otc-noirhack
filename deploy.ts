import { getInitialTestAccountsWallets } from '@aztec/accounts/testing';
import { EthAddress, createLogger, createPXEClient, waitForPXE } from '@aztec/aztec.js';
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
import * as fs from 'fs';

const MNEMONIC = 'test test test test test test test test test test test junk';
const { ETHEREUM_HOSTS = 'http://localhost:8545' } = process.env;
const MINT_AMOUNT = BigInt(1e4);

const { walletClient, publicClient } = createL1Clients(ETHEREUM_HOSTS.split(','), MNEMONIC);

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

async function setupSandbox() {
  const { PXE_URL = 'http://localhost:8080' } = process.env;
  const pxe = await createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  return pxe;
}

async function main() {
  const logger = createLogger('deploy');
  const pxe = await setupSandbox();
  const wallets = await getInitialTestAccountsWallets(pxe);
  const ownerWallet = wallets[0];
  const ownerAztecAddress = ownerWallet.getAddress();
  const l1ContractAddresses = (await pxe.getNodeInfo()).l1ContractAddresses;

  // Deploy L2 token contract
  const l2TokenContract = await TokenContract.deploy(ownerWallet, ownerAztecAddress, 'L2 Token', 'L2', 18)
    .send()
    .deployed();
  logger.info(`L2 token contract deployed at ${l2TokenContract.address}`);

  const psymmDeployment = await pSymmContract.deploy(ownerWallet, l2TokenContract.address);
  const psymmContract = await psymmDeployment.send().deployed();
  logger.info(`pSymm contract deployed at ${psymmContract.address}`);

  // Deploy L1 token contract
  const l1TokenContract = await deployTestERC20();
  logger.info('erc20 contract deployed');

  const feeAssetHandler = await deployFeeAssetHandler(l1TokenContract);
  await addMinter(l1TokenContract, feeAssetHandler);

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

  // Setup L1 portal contract
  await l1Portal.write.initialize(
    [l1ContractAddresses.registryAddress.toString(), l1TokenContract.toString(), l2BridgeContract.address.toString()],
    {},
  );
  logger.info('L1 portal contract initialized');

  // Write contract addresses to file
  const contracts = {
    l2Token: l2TokenContract.address,
    psymm: psymmContract.address,
    l1Token: l1TokenContract.toString(),
    feeAssetHandler: feeAssetHandler.toString(),
    l1Portal: l1PortalContractAddress.toString(),
    l2Bridge: l2BridgeContract.address
  };

  // Ensure web-demo/public directory exists
  const publicDir = './web-demo/public';
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // Write contracts.json to web-demo/public
  fs.writeFileSync(`${publicDir}/contracts.json`, JSON.stringify(contracts, null, 2));
  logger.info('Contract addresses written to web-demo/public/contracts.json');
}

main().catch(error => {
  console.error(`Error running script: ${error}`);
  process.exit(1);
});
