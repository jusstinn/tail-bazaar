// CLI: `demo [--evidence DIR] [--serve]` boots the server on PORT (the buyer agent retrieves over real
// HTTP), runs the local-demonstration pipeline against the configured chain, and exits unless --serve.
import fs from "node:fs";
import { chainMode, databasePath, port } from "./config.js";
import { startServer } from "./index.js";
import { runDemoPipeline } from "./pipeline.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "serve") { startServer(); return; }
  if (cmd !== "demo") { console.error("usage: cli.js demo [--evidence DIR] [--serve] | serve"); process.exit(2); }
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
