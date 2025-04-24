const assert = require("node:assert/strict");
const {
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox-viem/network-helpers");
const {
  bytesToHex,
  concat,
  toHex,
  hexToBytes,
  encodeAbiParameters,
  parseAbiParameters,
} = require("viem");
const { NativeUltraPlonkBackend } = require("./plonk.js");
const { Noir } = require("@noir-lang/noir_js");
const path = require("path");
const fs = require("fs");
const os = require("node:os");
const hre = require("hardhat");
const TOML = require("@iarna/toml");

const jsondata = require("#root/noir/pSymmCTC/target/pSymmCTC.json");

async function deployFixture() {
  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const backend = new NativeUltraPlonkBackend(
    path.join(os.homedir(), ".bb", "bb"),
    jsondata
  );
  const noir = new Noir(jsondata);

  // Deploy NoirTest contract
  const vATC = await hre.viem.deployContract(
    "contracts/src/noirPsymm/VerifierATC.sol:UltraVerifier"
  );
  const vCTC = await hre.viem.deployContract(
    "contracts/src/noirPsymm/VerifierCTC.sol:UltraVerifier"
  );

  return {
    vATC,
    vCTC,
    noir,
    backend,
    deployer,
    publicClient,
  };
}

describe("NoirTest - pSymmCTC", function () {
  it("Should verify a valid proof for note splitting", async function () {
    const { vCTC, backend, noir } = await loadFixture(deployFixture);

    // Load test data from Prover.toml
    const tomlData = TOML.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../noir/pSymmCTC/Prover.toml"),
        "utf8"
      )
    );

    // Format inputs for proof generation
    // const inputs = {
    //   note: tomlData.note,
    //   note_a: tomlData.note_a,
    //   note_b: tomlData.note_b,
    //   note_index: tomlData.note_index,
    //   note_hash_path: tomlData.note_hash_path,
    //   note_commitment: tomlData.note_commitment,
    //   noteA_commitment: tomlData.noteA_commitment,
    //   noteB_commitment: tomlData.noteB_commitment,
    //   nullifier_hash: tomlData.nullifier_hash,
    //   root: tomlData.root,
    //   note_custody_id: tomlData.note_custody_id,
    //   noteA_custody_id: tomlData.noteA_custody_id,
    //   noteB_custody_id: tomlData.noteB_custody_id,
    // };
    console.log("inputs", tomlData);

    // Generate the proof
    console.log("generating witness...");
    const { witness } = await noir.execute(tomlData);
    console.log("generating proof...");
    const { proof, publicInputs } = await backend.generateProof(
      Buffer.from(witness)
    );
    console.log("publicInputs", publicInputs);

    const proofHex = bytesToHex(proof);
    const result = await vCTC.read.verify([proofHex, publicInputs]);
    assert.equal(result, true, "Valid proof should verify");
  });
});
