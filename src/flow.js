/* flow.js: CROSSOVER's shared reader. Used by the site (browser) and the engine (node).
   classify(): one Solana transaction -> who bought/sold, how much SOL, and which app or terminal it came from.
   summarize()/detect(): app share of classified buys and the crossover rule. */
(function (root, make) { if (typeof module === "object" && module.exports) module.exports = make(); else root.FLOW = make(); })(this, function () {
  const WSOL = "So11111111111111111111111111111111111111112";
  const CAP = 2;            // one buy counts at most 2 SOL in the share, so a single whale can't flip it

  function index(fp) {
    const map = new Map(), byId = {};
    for (const e of fp.entries || []) { byId[e.id] = e; for (const a of e.addresses || []) map.set(a, e); }
    return { map, byId, entries: fp.entries || [], threshold: fp.threshold ?? 0.5 };
  }

  const amt = b => Number(b.uiTokenAmount.amount) / Math.pow(10, b.uiTokenAmount.decimals || 0);
  function deltas(meta, mint) {
    const d = new Map();
    for (const b of meta.preTokenBalances || []) if (b.mint === mint && b.owner) d.set(b.owner, (d.get(b.owner) || 0) - amt(b));
    for (const b of meta.postTokenBalances || []) if (b.mint === mint && b.owner) d.set(b.owner, (d.get(b.owner) || 0) + amt(b));
    return d;
  }

  // tx = getTransaction result ({ encoding: "json", maxSupportedTransactionVersion: 0 })
  function classify(tx, mint, IX) {
    if (!tx || !tx.meta || tx.meta.err || !tx.transaction) return null;
    const msg = tx.transaction.message, la = tx.meta.loadedAddresses || {};
    const K = [].concat(msg.accountKeys || [], la.writable || [], la.readonly || []).map(k => typeof k === "string" ? k : k.pubkey);
    const nSig = msg.header ? msg.header.numRequiredSignatures : 1;
    const signers = new Set(K.slice(0, nSig));
    const dm = deltas(tx.meta, mint);
    let trader = null, tok = 0;
    for (const [o, v] of dm) if (signers.has(o) && Math.abs(v) > Math.abs(tok)) { trader = o; tok = v; }
    if (!trader || !tok) return null;                       // not a wallet trade on this mint
    const i = K.indexOf(trader);
    const lam = i >= 0 && tx.meta.preBalances[i] != null ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
    const ws = deltas(tx.meta, WSOL).get(trader) || 0;
    const side = tok > 0 ? "buy" : "sell";
    const sol = Math.max(0, side === "buy" ? -(lam + ws) : lam + ws);
    // fingerprints: a strong match beats a weak one; an app and a terminal both matching = unreadable
    let strong = null, weak = null, clash = false;
    for (const k of K) {
      const e = IX.map.get(k); if (!e) continue;
      if (e.strength === "weak") { weak = weak || e; continue; }
      if (strong && strong.kind !== e.kind) clash = true;
      strong = strong || e;
    }
    const e = clash ? null : strong || weak;
    return { sig: (tx.transaction.signatures || [])[0], t: (tx.blockTime || 0) * 1000, side, sol: Math.round(sol * 1e4) / 1e4,
      wallet: trader, src: e ? e.id : null, kind: e ? e.kind : null, weak: !!(e && e.strength === "weak"), clash };
  }

  function summarize(trades, from, to) {
    const s = { app: 0, pro: 0, nApp: 0, nPro: 0, nUn: 0, nBuy: 0, nSell: 0, buySol: 0, sellSol: 0, bySrc: {} };
    for (const x of trades) {
      if (x.t < from || x.t >= to) continue;
      if (x.side === "sell") { s.nSell++; s.sellSol += x.sol; continue; }
      s.nBuy++; s.buySol += x.sol;
      const w = Math.min(CAP, x.sol || 0) || 0.01;
      if (x.kind === "app") { s.app += w; s.nApp++; } else if (x.kind === "pro") { s.pro += w; s.nPro++; } else s.nUn++;
      if (x.src) { const b = s.bySrc[x.src] = s.bySrc[x.src] || { n: 0, sol: 0 }; b.n++; b.sol += x.sol; }
    }
    const c = s.app + s.pro;
    s.n = s.nApp + s.nPro;
    s.share = c > 0 ? s.app / c : null;
    s.net = s.buySol - s.sellSol;
    s.cov = s.nBuy ? s.n / s.nBuy : 0;
    return s;
  }

  // The crossover: app share passes the line from below, rising, with more SOL buying than selling.
  const RULE = { window: 10 * 60e3, minN: 6, minPrev: 4, rise: 0.1 };
  function detect(trades, now, th, rule) {
    const R = Object.assign({}, RULE, rule || {}), W = R.window;
    const cur = summarize(trades, now - W, now + 1), prev = summarize(trades, now - 2 * W, now - W);
    const ok = cur.n >= R.minN && prev.n >= R.minPrev && cur.share !== null && prev.share !== null &&
      cur.share >= th && prev.share < th && cur.share - prev.share >= R.rise && cur.net > 0;
    return { ok, cur, prev };
  }
  function status(cur, prev, th) {
    if (!cur || cur.n < 4 || cur.share === null) return "thin";
    if (cur.share >= th) return "crossed";
    if (prev && prev.share !== null && cur.share >= th - 0.15 && cur.share > prev.share) return "crossing";
    return "pro-led";
  }
  // app share in a rolling window, sampled at n points ending at `end`
  function series(trades, end, step, n, win) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) { const t = end - i * step, s = summarize(trades, t - win, t); out.push(s.n >= 3 ? Math.round(s.share * 100) / 100 : null); }
    return out;
  }

  // ---- RPC with failover across endpoints ----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function rpc(endpoints, opt = {}) {
    let i = 0; const cool = new Map(); const st = { calls: 0, errors: 0, last: "" };
    async function call(method, params) {
      for (let tries = 0; tries < endpoints.length * 3; tries++) {
        const ep = endpoints[i++ % endpoints.length];
        if ((cool.get(ep) || 0) > Date.now()) { if (endpoints.every(e => (cool.get(e) || 0) > Date.now())) await sleep(1200); continue; }
        st.calls++;
        try {
          const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(opt.timeout || 15000) });
          if (!r.ok) { st.errors++; st.last = ep.replace(/\?.*/, "") + " " + r.status; cool.set(ep, Date.now() + (r.status === 429 ? 3000 : 20000)); continue; }
          const j = await r.json();
          if (j.error) { st.errors++; st.last = String(j.error.message || "").slice(0, 80);
            if (/rate|limit|too many|busy/i.test(j.error.message || "")) { cool.set(ep, Date.now() + 3000); continue; }
            const err = new Error(j.error.message); err.rpc = true; throw err; }
          st.ok = ep.replace(/\?.*/, "");
          return j.result;
        } catch (e) { if (e && e.rpc) throw e;
          st.errors++; st.last = (e && e.message) || String(e); cool.set(ep, Date.now() + 8000); }
      }
      throw new Error("no rpc endpoint answered");
    }
    return { call, st };
  }
  async function pool(items, n, fn) { const out = new Array(items.length); let k = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; } } }));
    return out; }
  const TXOPT = { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" };

  return { WSOL, CAP, RULE, index, classify, summarize, detect, status, series, rpc, pool, sleep, TXOPT };
});
