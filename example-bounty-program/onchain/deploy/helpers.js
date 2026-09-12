const fs = require("fs");
const path = require("path");

function outPath(network, chainId) {
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return path.join(dir, `${chainId}-${network}.json`);
}

function saveDeployment(network, chainId, data) {
  const file = outPath(network, chainId);
  // Handle BigInt serialization
  const jsonData = JSON.stringify(data, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  , 2);
  fs.writeFileSync(file, jsonData);
  console.log(`\nSaved deployment to ${file}\n`);
}

function readArtifact(artifactName) {
  const src = path.join(__dirname, "..", "artifacts", "contracts", `${artifactName}.sol`, `${artifactName}.json`);
  return JSON.parse(fs.readFileSync(src, "utf8"));
}

// One ABI fragment signature, for de-duplication (name + input types).
function fragmentKey(f) {
  const inputs = (f.inputs || []).map((i) => i.internalType || i.type).join(",");
  return `${f.type}:${f.name || ""}(${inputs})`;
}

/**
 * The BountyEscrow's CANONICAL ABI: the escrow's own fragments plus the read-only views
 * served from BountyEscrowLens through the escrow's delegating fallback. Every function in
 * it is callable AT THE ESCROW ADDRESS. The compiled BountyEscrow artifact alone is
 * incomplete (it lacks getSubmissions, getBounties, getOracleResult, nextAction,
 * prepareCutoff, canBeClosed, isAcceptingSubmissions, getEffectiveBountyStatus), so use
 * this everywhere an ABI is attached to the escrow: tests, scripts, the frontend export.
 *
 * Only the lens's functions are merged (not its constructor/fallback), and a fragment
 * the escrow already has (e.g. `verdikta()`) is not duplicated.
 */
function mergedAbi() {
  const escrow = readArtifact("BountyEscrow");
  const lens = readArtifact("BountyEscrowLens");
  const seen = new Set(escrow.abi.map(fragmentKey));
  const extra = lens.abi.filter(
    (f) => f.type === "function" && !seen.has(fragmentKey(f))
  );
  return [...escrow.abi, ...extra];
}

/**
 * Write the merged ABI as an artifact-shaped JSON (contractName + abi) so consumers that
 * read `require("…/BountyEscrow.json").abi` keep working. Default destination is the
 * frontend ABI folder; pass another `destRel` to export elsewhere.
 */
function copyAbiToFrontend(artifactName = "BountyEscrow", destRel = "frontend/src/abi") {
  try {
    const destDir = path.join(__dirname, "..", destRel);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${artifactName}.json`);
    const abi = artifactName === "BountyEscrow" ? mergedAbi() : readArtifact(artifactName).abi;
    const out = {
      _format: "merged-abi-v1",
      contractName: artifactName,
      note: artifactName === "BountyEscrow"
        ? "Escrow ABI + BountyEscrowLens views. All functions are callable at the escrow address (the escrow forwards lens selectors via a static delegatecall fallback)."
        : undefined,
      abi,
    };
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ABI to ${dest}`);
  } catch (e) {
    console.log(`Skipped ABI export (${e.message}).`);
  }
}

module.exports = { saveDeployment, copyAbiToFrontend, mergedAbi, readArtifact };

