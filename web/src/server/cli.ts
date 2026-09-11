// CLI: `demo [--evidence DIR] [--serve]` boots the server on PORT (the buyer agent retrieves over real
// HTTP), runs the local-demonstration pipeline against the configured chain, and exits unless --serve.
// `ledger [FILE]` exports the failure ledger for a GUARD-style pipeline.
import fs from "node:fs";
import path from "node:path";
import { chainMode, databasePath, port, REPO_ROOT } from "./config.js";
import { startServer } from "./index.js";
import { writeLedger } from "./ledger.js";
import { runDemoPipeline } from "./pipeline.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "serve") { startServer(); return; }
  if (cmd === "ledger") {
    const out = rest[0] ?? path.join(REPO_ROOT, "evidence", chainMode, "ledger.json");
    const { file, doc } = writeLedger(out);
    console.log(`wrote ${file}: ${doc.n_findings} finding(s) ${JSON.stringify(doc.verdict_counts)} over ${doc.n_search_runs} search simulations (${chainMode} database)`);
    console.log("NOTE: every row contains the scenario parameters buyers pay for. This file is operator/Loop-facing; no HTTP route serves it.");
    return;
  }
  if (cmd !== "demo") { console.error("usage: cli.js demo [--evidence DIR] [--serve] | serve | ledger [FILE]"); process.exit(2); }
  let evidence: string | null = null;
  let keep = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--evidence") evidence = rest[++i];
    else if (rest[i] === "--serve") keep = true;
    else if (rest[i] === "--reset") {
      if (chainMode !== "local") { console.error("--reset is only allowed in local chain mode"); process.exit(2); }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(databasePath + suffix, { force: true });
      console.log("local database reset");
    }
  }
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const server = startServer(port);
  try {
    const res = await runDemoPipeline({ evidenceDir: evidence, baseUrl: `http://127.0.0.1:${port}` });
    console.log(`pipeline ${res.run_id} done; orders: ${res.orders.join(", ")}`);
    if (!keep) { server.close(); process.exit(0); }
  } catch (e: any) {
    console.error("pipeline failed:", e?.message ?? e);
    if (!keep) { server.close(); process.exit(1); }
  }
}
main();
