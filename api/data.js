// GET /api/data -> the engine's data.json from the `flow-data` branch, cached 20 s at Vercel's edge.
const REPO = process.env.DATA_REPO || "buzzlightyear163/crossover";
const BRANCH = process.env.DATA_BRANCH || "flow-data";
let mem = null;
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const now = Date.now();
  try {
    if (!mem || now - mem.t > 15000) {
      const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/data.json?t=${Math.floor(now / 15000)}`, { cache: "no-store" });
      if (!r.ok) throw new Error("github " + r.status);
      mem = { t: now, body: await r.text() };
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=300");
    res.status(200).send(mem.body);
  } catch (e) {
    if (mem) { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "public, s-maxage=10"); res.status(200).send(mem.body); return; }
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
