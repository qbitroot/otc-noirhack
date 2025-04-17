const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

class NativeUltraPlonkBackend {
  constructor(bbPath, circuit) {
    this.circuit = circuit;
    this.bbPath = path.normalize(bbPath);
  }

  async generateProof(witness) {
    const targetDir = await this.#makeTargetDir();

    const circuitHash = await this.#getCircuitHash();
    const witnessHash = await this.#getWitnessHash(witness);

    const circuitJsonPath = path.join(targetDir, `${circuitHash}_circuit.json`);
    const witnessOutputPath = path.join(
      targetDir,
      `${circuitHash}_${witnessHash}_witness.gz`
    );
    const proofOutputPath = path.join(
      targetDir,
      `${circuitHash}_${witnessHash}_proof`
    );

    fs.writeFileSync(circuitJsonPath, JSON.stringify(this.circuit));
    fs.writeFileSync(witnessOutputPath, witness);
    const args = [
      "prove", // ultraplonk
      "-b",
      circuitJsonPath,
      "-w",
      witnessOutputPath,
      "-o",
      proofOutputPath,
    ];

    const bbProcess = spawn(this.bbPath, args);
    bbProcess.stdout.on("data", (data) => {
      console.log(`stdout: ${data}`);
    });

    bbProcess.stderr.on("data", (data) => {
      console.error(`stderr: ${data}`);
    });

    return await new Promise((resolve, reject) => {
      bbProcess.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}`));
          return;
        }

        const proof = fs.readFileSync(proofOutputPath);
        resolve(splitUltraPlonkProof(proof));
      });

      bbProcess.on("error", (err) => {
        reject(new Error(`Failed to start process: ${err.message}`));
      });
    });
  }

  async #getCircuitHash() {
    const input = new TextEncoder().encode(JSON.stringify(this.circuit));
    return (
      "0x" +
      Buffer.from(await crypto.subtle.digest("SHA-256", input)).toString("hex")
    );
  }

  async #getWitnessHash(witness) {
    return (
      "0x" +
      Buffer.from(await crypto.subtle.digest("SHA-256", witness)).toString(
        "hex"
      )
    );
  }

  async #makeTargetDir() {
    const targetDir = path.normalize(path.join(__dirname, "target"));
    fs.mkdirSync(targetDir, { recursive: true });
    return targetDir;
  }
}

async function splitUltraPlonkProof(proofData) {
  const proof = proofData.slice(-2144);
  const publicInputsFlat = proofData.slice(0, proofData.length - 2144);
  const publicInputs = deflattenFields(publicInputsFlat);
  return { proof, publicInputs };
}

function deflattenFields(flattenedFields) {
  const publicInputSize = 32;
  const chunkedFlattenedPublicInputs = [];

  for (let i = 0; i < flattenedFields.length; i += publicInputSize) {
    const publicInput = flattenedFields.slice(i, i + publicInputSize);
    chunkedFlattenedPublicInputs.push(publicInput);
  }

  return chunkedFlattenedPublicInputs.map(uint8ArrayToHex);
}

function uint8ArrayToHex(buffer) {
  const hex = [];

  buffer.forEach(function (i) {
    let h = i.toString(16);
    if (h.length % 2) {
      h = "0" + h;
    }
    hex.push(h);
  });

  return "0x" + hex.join("");
}

module.exports = {
  NativeUltraPlonkBackend,
  deflattenFields
};
