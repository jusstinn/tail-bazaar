// Router and shell. Three places to be: the marketplace, one finding, and the rules that decide who
// gets paid. The nav says which one you are on; nothing else in the app moves.
import { getJSON, type Status } from "./api.js";
import { esc, short } from "./format.js";
import { renderMarket, stopPolling } from "./market.js";
import { disposeReplay, renderOrder } from "./order.js";
import { renderRules } from "./rules.js";
import { armPage, badge } from "./ui.js";

const view = document.getElementById("view")!;
let status: Status | null = null;

const NAV: [string, string][] = [["#/", "Marketplace"], ["#/how-it-works", "How it works"]];

async function loadStatus(): Promise<Status> {
  if (!status) status = await getJSON<Status>("/api/status");
  return status;
}

function paintShell(active: string): void {
  const st = status!;
  document.getElementById("nav")!.innerHTML = NAV.map(([h, t]) => `<a href="${h}" class="${active === h ? "on" : ""}">${esc(t)}</a>`).join("");
  document.getElementById("chainbar")!.innerHTML = `
    ${badge(st.chain_mode === "testnet" ? "Base Sepolia" : "Local anvil", st.chain_mode === "testnet" ? "testnet" : "local")}
    <span class="chain-detail mono" title="${esc(st.chain_label)}">${st.escrow_address ? esc(short(st.escrow_address, 8, 6)) : "no escrow"}</span>
    <span class="chain-detail mono">block ${esc(st.latest_block ?? "—")}</span>
    ${st.hosted_mode ? badge("hosted", "") : ""}`;
}

function showError(e: unknown): void {
  view.innerHTML = `<section class="band hero"><div class="wrap"><div class="eyebrow">Something went wrong</div><h1 class="display">This page could not load.</h1><pre class="json">${esc((e as Error)?.message ?? e)}</pre><p class="cta-row"><a class="btn" href="#/">Back to the marketplace</a></p></div></section>`;
  armPage(view);
}

async function route(): Promise<void> {
  const hash = location.hash || "#/";
  disposeReplay();
  stopPolling();
  window.scrollTo({ top: 0, behavior: "auto" });
  const st = await loadStatus();
  const order = hash.match(/^#\/orders\/(0x[0-9a-fA-F]{64})$/);
  if (order) { paintShell(""); await renderOrder(view, order[1], st); return; }
  if (hash.startsWith("#/how-it-works")) { paintShell("#/how-it-works"); await renderRules(view, st); return; }
  paintShell("#/");
  await renderMarket(view, st);
}

function go(): void { route().catch(showError); }

window.addEventListener("hashchange", () => {
  // in-page anchors are handled with scrollIntoView, so only real routes re-render
  if (/^#\/|^$|^#$/.test(location.hash)) go();
});
go();
