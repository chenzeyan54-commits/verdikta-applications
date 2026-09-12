const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const addr = process.argv[2];
  if (!addr) throw new Error("Usage: npx hardhat run deploy/verify.js --network base <address>");
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
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

