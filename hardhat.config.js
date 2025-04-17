require("@nomicfoundation/hardhat-viem");
require("@nomicfoundation/hardhat-ignition-viem");

task("read", "Read a contract function")
  .addPositionalParam("contractName", "The name of the contract")
  .addPositionalParam("functionName", "The name of the function to read")
  .addVariadicPositionalParam("args", "Function arguments", [])
  .setAction(async (taskArgs, hre) => {
    const readTask = require("#root/demo/utils/read.task.js");
    await readTask(
      [taskArgs.contractName, taskArgs.functionName, ...taskArgs.args],
      hre
    );
  });

task("write", "Write to a contract function")
  .addPositionalParam("walletId", "The wallet ID to use")
  .addPositionalParam("contractName", "The name of the contract")
  .addPositionalParam("functionName", "The name of the function to write")
  .addVariadicPositionalParam("args", "Function arguments", [])
  .setAction(async (taskArgs, hre) => {
    const writeTask = require("#root/demo/utils/write.task.js");
    await writeTask(
      [
        taskArgs.walletId,
        taskArgs.contractName,
        taskArgs.functionName,
        ...taskArgs.args,
      ],
      hre
    );
  });

const verifierConf = {
  version: "0.8.27",
  settings: {
    optimizer: {
      enabled: true,
      runs: 2000,
    },
  },
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.27",
        settings: {
          viaIR: true,
          optimizer: { enabled: false },
        },
      },
    ],
    overrides: {
      "contracts/src/NoirTest/NoirTest.sol": verifierConf,
      "contracts/src/noirPsymm/VerifierCTC.sol": verifierConf,
      "contracts/src/noirPsymm/VerifierATC.sol": verifierConf,
    },
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
  paths: {
    sources: "./contracts/src/",
    tests: "./contracts/test/",
    cache: "./dist/hardhat/cache",
    artifacts: "./dist/hardhat/artifacts",
  },
  mocha: {
    timeout: 100000000,
  },
};
