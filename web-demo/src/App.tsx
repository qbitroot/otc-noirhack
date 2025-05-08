import { useEffect, useState } from 'react';
import { getInitialTestAccountsWallets } from '@aztec/accounts/testing';
import {
  EthAddress,
  Fr,
  L1TokenManager,
  L1TokenPortalManager,
  createLogger,
  createPXEClient,
  waitForPXE,
  type AccountWalletWithSecretKey,
  type PXE
} from '@aztec/aztec.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge';
import { pSymmContract } from '../../contracts/psymm/src/artifacts/pSymm';
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { mainnet } from 'viem/chains';

const MINT_AMOUNT = BigInt(1e4);
const PXE_URL = 'http://localhost:8080';

function App() {
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [pxe, setPxe] = useState<PXE | null>(null);
  const [wallet, setWallet] = useState<AccountWalletWithSecretKey | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // Initialize PXE client
  useEffect(() => {
    let mounted = true;

    async function initPXE() {
      try {
        setStatus('Initializing PXE client...');
        const pxeClient = createPXEClient(PXE_URL);
        await waitForPXE(pxeClient);
        
        if (mounted) {
          setPxe(pxeClient);
          setStatus('PXE client initialized. Please connect MetaMask.');
          setIsInitializing(false);
        }
      } catch (error) {
        console.error('Failed to initialize PXE:', error);
        if (mounted) {
          setError(error instanceof Error ? error.message : String(error));
          setIsInitializing(false);
        }
      }
    }

    initPXE();
    return () => { mounted = false; };
  }, []);

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        throw new Error('MetaMask not found! Please install MetaMask.');
      }
      
      if (!pxe) {
        throw new Error('PXE client not initialized');
      }

      setStatus('Connecting to MetaMask...');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts[0]) {
        throw new Error('No accounts found! Please connect to MetaMask.');
      }

      setStatus('Getting test accounts...');
      // Create an Aztec wallet using the initialized PXE client
      const testAccounts = await getInitialTestAccountsWallets(pxe);
      if (testAccounts.length === 0) {
        throw new Error('No test accounts available');
      }
      
      setWallet(testAccounts[0]);
      setStatus('Connected to MetaMask and created Aztec wallet. Ready to start demo.');
    } catch (error) {
      console.error('Failed to connect:', error);
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    async function runDemo() {
      if (!wallet || !pxe) return;
      
      try {
        setStatus('Starting pSymm web demo...');
        
        // Setup L1 clients with MetaMask
        if (!window.ethereum) {
          throw new Error('MetaMask not found! Please install MetaMask.');
        }
        
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const ownerEthAddress = accounts[0];
        
        // Create public client
        const publicClient = createPublicClient({
          chain: mainnet,
          transport: http('http://localhost:8545')
        });

        // Create wallet client with MetaMask
        const walletClient = createWalletClient({
          chain: mainnet,
          transport: custom(window.ethereum)
        });
        
        const logger = createLogger('psymm');
        const ownerAztecAddress = wallet.getAddress();
        const l1ContractAddresses = (await pxe.getNodeInfo()).l1ContractAddresses;

        setStatus('Connected to PXE and initialized wallets');

        // Read contract addresses from contracts.json
        const contracts = (await import('../../contracts.json')).default;

        // Initialize contract instances
        const l2TokenContract = await TokenContract.at(contracts.l2Token, wallet);
        const psymmContract = await pSymmContract.at(contracts.psymm, wallet);
        const l2BridgeContract = await TokenBridgeContract.at(contracts.l2Bridge, wallet);

        setStatus('Initialized contract instances');

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
        setStatus('Bridging tokens from L1 to L2...');
        const claim = await l1PortalManager.bridgeTokensPrivate(ownerAztecAddress, MINT_AMOUNT, true);

        // Process L1->L2 messages
        await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();
        await l2TokenContract.methods.mint_to_public(ownerAztecAddress, 0n).send().wait();

        // Claim tokens on L2
        await l2BridgeContract.methods
          .claim_private(ownerAztecAddress, MINT_AMOUNT, claim.claimSecret, claim.messageLeafIndex)
          .send()
          .wait();

        const balance = await l2TokenContract.methods.balance_of_private(ownerAztecAddress).simulate();
        setStatus(`Private L2 balance: ${balance}`);

        // Get contract config
        const config = await psymmContract.methods.get_config().simulate();
        setStatus(`Contract config loaded. Token address: ${config.token}`);

        setStatus('Demo completed successfully!');
      } catch (error) {
        console.error('Demo failed:', error);
        setError(error instanceof Error ? error.message : String(error));
      }
    }

    runDemo();
  }, [wallet, pxe]);

  return (
    <div style={{ padding: '20px' }}>
      <h1>pSymm Web Demo</h1>
      <div style={{ marginTop: '20px' }}>
        <button 
          onClick={connectWallet}
          disabled={isInitializing || !pxe}
          style={{ 
            padding: '10px 20px',
            marginBottom: '20px',
            fontSize: '16px',
            cursor: isInitializing || !pxe ? 'not-allowed' : 'pointer',
            opacity: isInitializing || !pxe ? 0.5 : 1
          }}
        >
          {isInitializing ? 'Initializing...' : 'Connect MetaMask'}
        </button>
        <h3>Status:</h3>
        <p>{status}</p>
        {error && (
          <div style={{ color: 'red', marginTop: '20px' }}>
            <h3>Error:</h3>
            <p>{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
