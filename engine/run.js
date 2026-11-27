/* CROSSOVER engine. One run = ~4 minutes of reading the flow, then the state is saved.
   GitHub Actions starts a run every 5 minutes (.github/workflows/engine.yml), so it runs around the clock.

   1. GeckoTerminal (free, no key): the hottest pump.fun, PumpSwap and Raydium LaunchLab coins right now.
   2. Solana RPC (public, or Helius if the HELIUS_API_KEY secret is set): their newest trades, one transaction at a time.
   3. src/flow.js: every buy is matched against fingerprints.json (app or terminal), app share per coin, the crossover rule.
   4. Every crossover is written to the signal log with its price, and measured again after 15 min, 1 h and 4 h.
   The engine's buys are a preview: it logs what it would buy, it does not trade.

   Usage: node engine/run.js   (env: DATA_DIR=./data RUN_MS=250000 HELIUS_API_KEY=optional) */
const fs = require("fs"), path = require("path");
const FLOW = require("../src/flow.js");
const FP = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fingerprints.json"), "utf8"));
const IX = FLOW.index(FP), TH = IX.threshold;

const DATA = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const RUN_MS = +(process.env.RUN_MS || 250e3);
const KEY = process.env.HELIUS_API_KEY || "";
const RPCS = [KEY && `https://mainnet.helius-rpc.com/?api-key=${KEY}`, "https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"].filter(Boolean);
const RATE = KEY ? 8 : 2.5;               // RPC calls per second we allow ourselves
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const DEXES = ["pump-fun", "raydium-launchlab", "pumpswap"];
const MAX_WATCH = 12, KEEP_TRADES = 45 * 60e3, COOLDOWN = 3 * 3600e3, ENGINE_SOL = 0.5;
const OUT = [["m15", 15 * 60e3], ["h1", 3600e3], ["h4", 4 * 3600e3]];
const sleep = FLOW.sleep;
const R = FLOW.rpc(RPCS, { timeout: 15000 });
let gtReads = 0, gtErrors = 0;

// ---------- rate limiter for RPC ----------
let nextSlot = 0;
async function slot() { const now = Date.now(), at = Math.max(now, nextSlot); nextSlot = at + 1000 / RATE; if (at > now) await sleep(at - now); }
async function call(method, params) { await slot(); return R.call(method, params); }

async function getJSON(url) {
  gtReads++;
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "crossover-engine/1" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) { gtErrors++; throw new Error(r.status + " " + url.slice(0, 80)); }
  return r.json();
}

// ---------- state ----------
function load() {
  try { const s = JSON.parse(fs.readFileSync(path.join(DATA, "engine.json"), "utf8")); if (s.v === 1) return s; } catch (e) {}
  console.log("no saved state, starting the engine");
  return { v: 1, born: Date.now(), coins: {}, signals: [], feed: [], hours: {}, runs: 0, fingerprinted: 0 };
}
const hk = t => Math.floor(t / 3600e3);
function feed(st, e) { st.feed.push(Object.assign({ t: Date.now() }, e)); if (st.feed.length > 150) st.feed.splice(0, st.feed.length - 150); }
const lpOf = (dex, mint) => (dex === "raydium-launchlab" || /bonk$/.test(mint) ? "launchlab" : "pump.fun");

// ---------- 1. discovery ----------
async function discover(st, now) {
  const cand = [];
  for (const dex of DEXES) {
    try {
      const j = await getJSON(`${GT}/dexes/${dex}/pools?sort=h24_volume_usd_desc&page=1`);
      for (const p of j.data || []) {
        const a = p.attributes || {}, rel = p.relationships || {};
        let mint = ((rel.base_token && rel.base_token.data && rel.base_token.data.id) || "").replace(/^solana_/, "");
        let sym = String(a.name || "").split(" / ")[0];
        if (mint === FLOW.WSOL) { mint = ((rel.quote_token && rel.quote_token.data && rel.quote_token.data.id) || "").replace(/^solana_/, ""); sym = String(a.name || "").split(" / ")[1] || sym; }
        if (!mint || mint === FLOW.WSOL) continue;
        const tx5 = (a.transactions && a.transactions.m5) || {};
        cand.push({ m: mint, sym: sym.replace(/[^\w$.\- ]/g, "").slice(0, 14), dex, pool: a.address, b5: +tx5.buys || 0, s5: +tx5.sells || 0,
          px: +a.base_token_price_usd || null, mc: +a.market_cap_usd || +a.fdv_usd || null, created: Date.parse(a.pool_created_at) || null });
      }
    } catch (e) { console.log("discover", dex, e.message); }
    await sleep(400);
  }
  // keep coins we already watch if they're still trading, then fill with the hottest
  const byM = new Map(); for (const c of cand) { const o = byM.get(c.m); if (!o || c.b5 > o.b5) byM.set(c.m, c); }
  for (const c of byM.values()) {
    const C = st.coins[c.m] = Object.assign(st.coins[c.m] || { m: c.m, trades: [], first: now }, { sym: c.sym, dex: c.dex, pool: c.pool, lp: lpOf(c.dex, c.m), b5: c.b5, s5: c.s5, seen: now });
    if (c.px) { C.px = c.px; C.pxAt = now; } if (c.mc) C.mc = c.mc;
  }
  const hot = Object.values(st.coins).filter(C => C.seen === now && C.b5 >= 6).sort((a, b) => b.b5 - a.b5);
  const keep = Object.values(st.coins).filter(C => C.watch && now - C.seen < 10 * 60e3 && C.b5 >= 3);
  const next = new Set(keep.map(C => C.m));
  for (const C of hot) { if (next.size >= MAX_WATCH) break; next.add(C.m); }
  for (const C of Object.values(st.coins)) {
    const w = next.has(C.m);
    if (w && !C.watch) { C.watchFrom = now; feed(st, { k: "watch", m: C.m, sym: C.sym, lp: C.lp, msg: `${C.b5} buys in 5 min` }); }
    if (!w && C.watch) feed(st, { k: "drop", m: C.m, sym: C.sym, lp: C.lp, msg: "cooled off" });
    C.watch = w;
  }
  return next.size;
}

// ---------- 2. read one coin ----------
async function readCoin(st, C, now) {
  const opt = { limit: C.lastSig ? 200 : 300 }; if (C.lastSig) opt.until = C.lastSig;
  let sigs;
  try { sigs = await call("getSignaturesForAddress", [C.m, opt]); } catch (e) { return 0; }
  sigs = (sigs || []).filter(s => !s.err);
  if (!sigs.length) return 0;
  C.lastSig = sigs[0].signature;
  const known = new Set(C.trades.map(x => x.sig));
  let pick;
  if (!C.seeded) { const n = Math.min(24, sigs.length), step = sigs.length / n; pick = Array.from({ length: n }, (_, i) => sigs[Math.floor(i * step)]); C.seeded = 1; }
  else { pick = sigs.slice(0, 10); const rest = sigs.slice(10); for (let i = 0; i < 4 && rest.length; i++) pick.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]); }
  let got = 0;
  for (const s of pick) {
    if (known.has(s.signature)) continue;
    let tx; try { tx = await call("getTransaction", [s.signature, FLOW.TXOPT]); } catch (e) { continue; }
    const x = FLOW.classify(tx, C.m, IX); if (!x) continue;
    if (!x.t) x.t = (s.blockTime || 0) * 1000 || now;
    C.trades.push({ sig: x.sig, t: x.t, side: x.side, sol: x.sol, kind: x.kind, src: x.src });
    got++;
    if (x.side === "buy") { st.fingerprinted++; const H = st.hours[hk(x.t)] = st.hours[hk(x.t)] || { b: 0, a: 0, p: 0, u: 0, src: {} };
      H.b++; if (x.kind === "app") H.a++; else if (x.kind === "pro") H.p++; else H.u++; if (x.src) H.src[x.src] = (H.src[x.src] || 0) + 1; }
    if (Date.now() - now > 40e3) break;
  }
  C.trades = C.trades.filter(x => x.t > Date.now() - KEEP_TRADES).sort((a, b) => a.t - b.t);
  C.read = Date.now();
  return got;
}

// ---------- 3. crossover rule ----------
function check(st, C, now) {
  const d = FLOW.detect(C.trades, now, TH);
  C.share = d.cur.share; C.prev = d.prev.share; C.n = d.cur.n; C.cov = d.cur.cov; C.net = d.cur.net;
  const was = C.status; C.status = FLOW.status(d.cur, d.prev, TH);
  if (C.status === "crossing" && was !== "crossing" && was !== "crossed") feed(st, { k: "heat", m: C.m, sym: C.sym, lp: C.lp, msg: `app share ${pct(d.cur.share)} and rising` });
  if (!d.ok || (C.lastCross && now - C.lastCross < COOLDOWN)) return;
  C.lastCross = now;
  const top = Object.entries(d.cur.bySrc).filter(([id]) => IX.byId[id] && IX.byId[id].kind === "app").sort((a, b) => b[1].n - a[1].n)[0];
  const sig = { id: "X" + String(st.signals.length + 1).padStart(4, "0"), t: now, m: C.m, sym: C.sym, lp: C.lp, prev: r2(d.prev.share), share: r2(d.cur.share),
    n: d.cur.n, net: r2(d.cur.net), via: top ? top[0] : null, px0: C.pxAt && now - C.pxAt < 5 * 60e3 ? C.px : null, mc0: C.mc || null, out: {}, engine: { sol: ENGINE_SOL, status: "preview" } };
  st.signals.push(sig);
  feed(st, { k: "cross", m: C.m, sym: C.sym, lp: C.lp, msg: `crossed to the apps: ${pct(d.prev.share)} → ${pct(d.cur.share)}` + (top ? `, led by ${IX.byId[top[0]].name}` : "") });
  console.log("CROSSOVER", C.sym, C.m, pct(d.prev.share), "->", pct(d.cur.share));
}
const r2 = v => v === null || v === undefined ? null : Math.round(v * 100) / 100;
const pct = v => v === null || v === undefined ? "–" : Math.round(v * 100) + "%";

// ---------- 4. prices for the signal log ----------
async function prices(st, now) {
  const need = new Set();
  for (const s of st.signals) { if (!s.px0 && now - s.t < 30 * 60e3) need.add(s.m); for (const [k, ms] of OUT) if (s.out[k] === undefined && now >= s.t + ms) need.add(s.m); }
  if (!need.size) return;
  const list = [...need].slice(0, 30);
  try {
    const j = await getJSON(`${GT}/tokens/multi/${list.join(",")}`);
    const px = {}; for (const d of j.data || []) { const a = d.attributes || {}; px[a.address] = +a.price_usd || null; }
    for (const s of st.signals) {
      const p = px[s.m]; if (!p) continue;
      if (!s.px0) { s.px0 = p; s.px0Late = 1; continue; }
      for (const [k, ms] of OUT) if (s.out[k] === undefined && now >= s.t + ms) { s.out[k] = Math.round((p / s.px0 - 1) * 1000) / 10; if (now - s.t - ms > 15 * 60e3) (s.late = s.late || {})[k] = 1; }
    }
  } catch (e) { console.log("prices", e.message); }
  // give up on outcomes that can't be measured within a day
  for (const s of st.signals) for (const [k, ms] of OUT) if (s.out[k] === undefined && now > s.t + ms + 24 * 3600e3) s.out[k] = null;
}

// ---------- save ----------
function build(st, now, runMs) {
  const since = now - 24 * 3600e3, tot = { b: 0, a: 0, p: 0, u: 0 }, src = {};
  for (const [h, H] of Object.entries(st.hours)) { if (+h * 3600e3 < since - 3600e3) continue; tot.b += H.b; tot.a += H.a; tot.p += H.p; tot.u += H.u; for (const [k, v] of Object.entries(H.src)) src[k] = (src[k] || 0) + v; }
  const watch = Object.values(st.coins).filter(C => C.watch).sort((a, b) => (b.share ?? -1) - (a.share ?? -1)).map(C => ({
    m: C.m, sym: C.sym, lp: C.lp, mc: C.mc || null, b5: C.b5, share: r2(C.share), prev: r2(C.prev), n: C.n || 0, cov: r2(C.cov), net: r2(C.net), status: C.status || "thin",
    series: FLOW.series(C.trades, now, 120e3, 15, 6 * 60e3),
    last: C.trades.filter(x => x.side === "buy").slice(-6).reverse().map(x => ({ t: x.t, src: x.src, kind: x.kind, sol: x.sol })) }));
  const sigs = st.signals.slice(-200).reverse();
  const done = st.signals.filter(s => typeof s.out.h1 === "number");
  const h1 = done.map(s => s.out.h1).sort((a, b) => a - b);
  return {
    v: 1, updated: now, born: st.born, runs: st.runs,
    run: { ms: runMs, rpc: KEY ? "helius" : "public", calls: R.st.calls, errors: R.st.errors, gt: gtReads, gtErrors },
    totals: { buys24: tot.b, app24: tot.a, pro24: tot.p, un24: tot.u, share24: tot.a + tot.p ? r2(tot.a / (tot.a + tot.p)) : null,
      cross24: st.signals.filter(s => s.t > since).length, crossAll: st.signals.length, fingerprinted: st.fingerprinted,
      measured: done.length, hit1h: done.length ? r2(done.filter(s => s.out.h1 > 0).length / done.length) : null, med1h: h1.length ? h1[Math.floor(h1.length / 2)] : null },
    sources: Object.entries(src).map(([id, n]) => ({ id, n, kind: IX.byId[id] ? IX.byId[id].kind : null })).sort((a, b) => b.n - a.n),
    watch, signals: sigs, feed: st.feed.slice(-60).reverse(), threshold: TH, rule: FLOW.RULE };
}
function save(st, now, runMs) {
  fs.mkdirSync(DATA, { recursive: true });
  // forget coins we haven't seen for 6 hours (signals keep their own copy)
  for (const [m, C] of Object.entries(st.coins)) if (now - (C.seen || 0) > 6 * 3600e3) delete st.coins[m]; else if (!C.watch) C.trades = [];
  for (const h of Object.keys(st.hours)) if (+h < hk(now) - 48) delete st.hours[h];
  fs.writeFileSync(path.join(DATA, "engine.json"), JSON.stringify(st));
  const out = build(st, now, runMs);
  fs.writeFileSync(path.join(DATA, "data.json"), JSON.stringify(out));
  fs.writeFileSync(path.join(DATA, "vercel.json"), JSON.stringify({ git: { deploymentEnabled: false } }));
  fs.writeFileSync(path.join(DATA, "README.md"), "# CROSSOVER engine data\n\nWritten by the engine every few minutes (GitHub Actions). Do not edit by hand.\n\n- `data.json`: what the site shows\n- `engine.json`: the engine's working state\n");
  return out;
}

// ---------- run ----------
(async () => {
  const t0 = Date.now(), st = load(); st.runs++;
  let nextDisc = 0, nextPx = 0, i = 0, reads = 0;
  while (Date.now() - t0 < RUN_MS) {
    const now = Date.now();
    if (now >= nextDisc) { nextDisc = now + 75e3; const n = await discover(st, now); console.log("watching", n, "coins"); }
    if (now >= nextPx) { nextPx = now + 60e3; await prices(st, now); }
    const W = Object.values(st.coins).filter(C => C.watch).sort((a, b) => (a.read || 0) - (b.read || 0));
    if (!W.length) { await sleep(5000); continue; }
    const C = W[0];
    reads += await readCoin(st, C, Date.now());
    check(st, C, Date.now());
    if (++i % 10 === 0) console.log(`reads ${reads} rpc ${R.st.calls} errors ${R.st.errors} ${R.st.last || ""}`);
  }
  const out = save(st, Date.now(), Date.now() - t0);
  console.log(`saved: ${out.watch.length} watched, ${out.totals.buys24} buys 24h, share ${out.totals.share24}, ${out.totals.crossAll} crossovers, rpc ${R.st.calls}/${R.st.errors} err`);
})().catch(e => { console.error(e); process.exit(1); });
