import { createL1Clients } from '@aztec/ethereum';

const MNEMONIC = 'test test test test test test test test test test test junk';
const { ETHEREUM_HOSTS = 'http://localhost:8545' } = process.env;

async function main() {
  if (process.argv.length !== 3) {
    console.error('Usage: node mint.js <ethereum_address>');
    process.exit(1);
  }

  const targetAddress = process.argv[2];
  const amount = '1000000000000000000'; // 1 ETH in wei

  try {
    const { walletClient } = createL1Clients(ETHEREUM_HOSTS.split(','), MNEMONIC);
    
    console.log(`Minting ${amount} wei to address ${targetAddress}...`);
    
    const hash = await walletClient.sendTransaction({
      to: targetAddress,
      value: BigInt(amount)
    });

    console.log(`Transaction sent with hash: ${hash}`);
    console.log('Waiting for transaction confirmation...');
    
    const receipt = await walletClient.waitForTransactionReceipt({ hash });
    console.log('Transaction confirmed in block:', receipt.blockNumber);
    console.log('Successfully minted ETH to target address');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
