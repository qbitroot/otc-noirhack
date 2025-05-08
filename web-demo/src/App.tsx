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
  const [ownerWallet, setOwnerWallet] = useState<AccountWalletWithSecretKey | null>(null);
  const [secondWallet, setSecondWallet] = useState<AccountWalletWithSecretKey | null>(null);
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
      // Create Aztec wallets using the initialized PXE client
      const testAccounts = await getInitialTestAccountsWallets(pxe);
      if (testAccounts.length < 2) {
        throw new Error('Not enough test accounts available');
      }
      
      console.log(testAccounts[0]);
      console.log(testAccounts[1]);
      setOwnerWallet(testAccounts[0]);
      setSecondWallet(testAccounts[1]);
      setStatus('Connected to MetaMask and created Aztec wallets. Ready to start demo.');
    } catch (error) {
      console.error('Failed to connect:', error);
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    async function runDemo() {
      if (!ownerWallet || !secondWallet || !pxe) return;
      
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
        const ownerAztecAddress = ownerWallet.getAddress();
        const secondAztecAddress = secondWallet.getAddress();
        const l1ContractAddresses = (await pxe.getNodeInfo()).l1ContractAddresses;

        setStatus('Connected to PXE and initialized wallets');

        // Read contract addresses from public/contracts.json
        const contracts = await fetch('/contracts.json').then(res => res.json());

        debugger;

        // Initialize contract instances using existing contracts
        const psymmContract = await pSymmContract.at(contracts.psymm, ownerWallet);
        const l2TokenContract = await TokenContract.at(contracts.l2Token, ownerWallet);
        const l2BridgeContract = await TokenBridgeContract.at(contracts.l2Bridge, ownerWallet);

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
        setStatus('Sent 2 dummy txs to advance L1->L2 message processing');

        // Claim tokens on L2
        await l2BridgeContract.methods
          .claim_private(ownerAztecAddress, MINT_AMOUNT, claim.claimSecret, claim.messageLeafIndex)
          .send()
          .wait();

        const balance = await l2TokenContract.methods.balance_of_private(ownerAztecAddress).simulate();
        setStatus(`Private L2 balance of ${ownerAztecAddress} is ${balance}`);

        // Get contract config
        const config = await psymmContract.methods.get_config().simulate();
        setStatus(`Contract config loaded. Token address: ${config.token}`);

        // Transfer tokens to custody ID 0 privately
        const transferAmount = BigInt(100);
        
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
        setStatus('Private authwit created for L2 transfer');
        
        // Transfer to custody ID with authwit
        await psymmContract.methods
          .address_to_custody(custodyId, parties, 0, transferAmount, transferNonce)
          .send({ authWitnesses: [authwitTransfer] })
          .wait();
        setStatus(`Transferred ${transferAmount} tokens to custody ID ${custodyId} privately`);

        // Check custody balance after transfer from owner's perspective
        const custodyBalance = await psymmContract.methods.custody_balance(custodyId, ownerAztecAddress).simulate();
        setStatus(`Custody balance for ID ${custodyId} from owner's view is ${custodyBalance}`);
        const custodyBalance2 = await psymmContract.withWallet(secondWallet).methods.custody_balance(custodyId, ownerAztecAddress).simulate();
        setStatus(`Custody balance for ID ${custodyId} from second user's view is ${custodyBalance2}`);

        // Transfer tokens from custody ID 0 back to address
        const withdrawAmount = BigInt(50);
        const withdrawNonce = Fr.random();

        // Get approval from counterparty first
        await psymmContract.withWallet(secondWallet).methods
          .approve_withdrawal(ownerAztecAddress, custodyId, withdrawAmount, withdrawNonce)
          .send()
          .wait();
        setStatus(`Counterparty approved withdrawal of ${withdrawAmount} tokens`);

        // Now execute the withdrawal with approval
        await psymmContract.withWallet(ownerWallet).methods
          .custody_to_address(custodyId, parties, 0, withdrawAmount, withdrawNonce)
          .send()
          .wait();
        setStatus(`Transferred ${withdrawAmount} tokens from custody ID ${custodyId} to address`);
        
        // Check final balances
        const finalCustodyBalance = await psymmContract.methods.custody_balance(custodyId, ownerAztecAddress).simulate();
        setStatus(`Final custody balance for ID ${custodyId} from owner's view is ${finalCustodyBalance}`);
        const finalCustodyBalance2 = await psymmContract.withWallet(secondWallet).methods.custody_balance(custodyId, ownerAztecAddress).simulate();
        setStatus(`Final custody balance for ID ${custodyId} from second user's view is ${finalCustodyBalance2}`);

        // Check balances from second wallet's perspective for both addresses
        const ownerBalanceFromSecond = await psymmContract.withWallet(secondWallet).methods.custody_balance_from(custodyId, ownerAztecAddress).simulate();
        setStatus(`Owner's custody balance for ID ${custodyId} viewed from second wallet: ${ownerBalanceFromSecond}`);
        
        const secondBalanceFromSecond = await psymmContract.withWallet(secondWallet).methods.custody_balance_from(custodyId, secondAztecAddress).simulate();
        setStatus(`Second wallet's custody balance for ID ${custodyId} viewed from second wallet: ${secondBalanceFromSecond}`);

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
        setStatus('Private authwit created for L2 withdrawal burn');

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
        setStatus('Withdrawal initiated on L2 privately');

        const newL2Balance = await l2TokenContract.methods.balance_of_private(ownerAztecAddress).simulate();
        setStatus(`New L2 balance of ${ownerAztecAddress} is ${newL2Balance}`);

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
        setStatus('Withdrawal completed on L1');

        const newL1Balance = await l1TokenManager.getL1TokenBalance(ownerEthAddress);
        setStatus(`New L1 balance of ${ownerEthAddress} is ${newL1Balance}`);

        setStatus('Demo completed successfully!');
      } catch (error) {
        console.error('Demo failed:', error);
        const errorMessage = error instanceof Error ? 
          `${error.message}\n${error.stack}` : 
          String(error);
        setError(errorMessage);
      }
    }

    runDemo();
  }, [ownerWallet, secondWallet, pxe]);

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
        <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{status}</pre>
        {error && (
          <div style={{ color: 'red', marginTop: '20px' }}>
            <h3>Error:</h3>
            <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{error}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
