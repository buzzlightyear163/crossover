// POST /api/rpc -> a read-only Solana RPC for the coin reader on the site.
// Uses HELIUS_API_KEY (Vercel env var, free key from helius.dev) when it is set, otherwise a public RPC.
// Only the two read calls the reader needs are allowed.
const ALLOW = new Set(["getSignaturesForAddress", "getTransaction"]);
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  let b = req.body;
  try { if (typeof b === "string") b = JSON.parse(b); } catch (e) { b = null; }
  if (!b || Array.isArray(b) || !ALLOW.has(b.method) || !Array.isArray(b.params)) { res.status(400).json({ error: "method not allowed" }); return; }
  const [first, opt] = b.params;
  if (b.method === "getSignaturesForAddress" && !ADDR.test(String(first))) { res.status(400).json({ error: "bad address" }); return; }
  if (b.method === "getTransaction" && !SIG.test(String(first))) { res.status(400).json({ error: "bad signature" }); return; }
  const key = process.env.HELIUS_API_KEY;
  const url = key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : "https://solana-rpc.publicnode.com";
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: b.method, params: [first, opt || {}] }), signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(r.ok ? 200 : r.status).send(text);
  } catch (e) { res.status(504).json({ error: "upstream timeout" }); }
};
