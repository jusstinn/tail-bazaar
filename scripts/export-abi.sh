#!/usr/bin/env bash
# Build the contract and copy its ABI into web/abi/ (committed; used by the TypeScript server).
. "$(dirname "$0")/env.sh"
cd "$ROOT/contracts" && forge build --silent
node -e '
const fs=require("fs");
const art=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
fs.writeFileSync(process.argv[2], JSON.stringify(art.abi,null,1)+"\n");
console.log("wrote", process.argv[2], "(", art.abi.length, "entries )");
' "$ROOT/contracts/out/FailureEscrow.sol/FailureEscrow.json" "$ROOT/web/abi/FailureEscrow.json"
