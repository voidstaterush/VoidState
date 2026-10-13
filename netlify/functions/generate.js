// VoidStateOfficial backend. One file, all model calls. Keys stay in env vars.
// POST {action:"generate"|"status", ...}. Swap providers by editing PROVIDERS below.

const BLOCKED = [
  /\b(deepfake|face ?swap|nude|naked|porn|sexual|gore|beheading|suicide|child abuse)\b/i,
  /\b(taylor swift|elon musk|donald trump|joe biden|barack obama|kim kardashian)\b/i, // real people: extend this list
  /\b(mickey mouse|spider-?man|batman|pikachu|mario|harry potter|star wars|marvel|disney)\b/i, // copyrighted characters
];
const hits = new Map(); // best-effort rate limit (resets when the function restarts)
const LIMIT = 8, WINDOW = 60_000;

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------- PROVIDERS: each returns {url} (done) or {id} (poll with status) ----------
const PROVIDERS = {
  // a) Demo mode: no key needed
  mock: async () => ({ url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" }),

  // b) Replicate (async: returns an id, then we poll)
  replicate: async ({ prompt, aspect }) => {
    const model = process.env.REPLICATE_MODEL || "wavespeedai/wan-2.1-t2v-480p";
    const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { prompt, aspect_ratio: aspect } }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Replicate error");
    return { id: d.id };
  },

  // c) Hugging Face Inference (sync: returns video bytes; may be slow or queued on free tier)
  huggingface: async ({ prompt }) => {
    const model = process.env.HF_MODEL || "Lightricks/LTX-Video";
    const r = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: prompt }),
    });
    if (!r.ok) throw new Error("Hugging Face: " + (await r.text()).slice(0, 200));
    const buf = Buffer.from(await r.arrayBuffer());
    return { url: `data:video/mp4;base64,${buf.toString("base64")}` };
  },
};

async function replicateStatus(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
  });
  const d = await r.json();
  if (d.status === "succeeded") return { status: "done", url: Array.isArray(d.output) ? d.output[0] : d.output };
  if (d.status === "failed" || d.status === "canceled") return { status: "failed", error: d.error || "Generation failed" };
  return { status: "working" };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const ip = event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (recent.length >= LIMIT) return json(429, { error: "Too many requests. Wait a minute and try again." });
  hits.set(ip, [...recent, now]);

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }

  try {
    if (b.action === "status") {
      if (typeof b.id !== "string" || b.id.length > 100) return json(400, { error: "Bad id" });
      return json(200, await replicateStatus(b.id));
    }
    // generate: validate + moderate
    const prompt = String(b.prompt || "").trim();
    if (prompt.length < 5 || prompt.length > 1500) return json(400, { error: "Describe your scene in 5 to 1500 characters." });
    if (BLOCKED.some((re) => re.test(prompt)))
      return json(422, { error: "That prompt names a real person, a copyrighted character, or restricted content. Try an original character or an 'inspired by' description of the mood and style." });
    const aspect = ["16:9", "9:16", "1:1"].includes(b.aspect) ? b.aspect : "16:9";
    const name = process.env.PROVIDER || "mock";
    if (!PROVIDERS[name]) return json(500, { error: "Unknown PROVIDER" });
    return json(200, await PROVIDERS[name]({ prompt, aspect }));
  } catch (e) {
    return json(502, { error: e.message });
  }
};
