const hre = require("hardhat");
require("dotenv").config();

async function main() {
  // `hardhat run` does not forward positional arguments (HH308): pass the escrow as ESCROW=0x…
  const addr = process.env.ESCROW || process.argv[2];
  if (!addr) throw new Error("Usage: ESCROW=0x… npx hardhat run deploy/verify.js --network base");
  const verdikta = hre.network.name === "base"
    ? process.env.VERDIKTA_AGGREGATOR_BASE
    : process.env.VERDIKTA_AGGREGATOR_BASE_SEPOLIA;
  await hre.run("verify:verify", {
    address: addr,
    constructorArguments: [verdikta]
  });
  // Also verify the lens the escrow created in its constructor (same constructor argument).
  const escrow = await hre.ethers.getContractAt("BountyEscrow", addr);
  const lensAddr = await escrow.lens();
  console.log(`Verifying BountyEscrowLens at ${lensAddr}`);
  await hre.run("verify:verify", {
    address: lensAddr,
    contract: "contracts/BountyEscrowLens.sol:BountyEscrowLens",
    constructorArguments: [verdikta]
  });
  const walletImplAddr = await escrow.walletImplementation();
  console.log(`Verifying EvaluationWallet implementation at ${walletImplAddr}`);
  await hre.run("verify:verify", {
    address: walletImplAddr,
    contract: "contracts/EvaluationWallet.sol:EvaluationWallet",
    constructorArguments: [addr, verdikta]
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

