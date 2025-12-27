import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const SPEEDY_BASE = "https://api.speedy.bg/v1";

function withAuth(body = {}) {
  return {
    userName: body.userName || body?.userName,
    password: body.password || body?.password,
    language: "BG",
    ...body,
  };
}

async function speedyPost(path, body) {
  const res = await fetch(SPEEDY_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withAuth(body)),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: res.ok, status: res.status, json, raw: text };
}

async function speedyPostPdf(path, body) {
  const res = await fetch(SPEEDY_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withAuth(body)),
  });

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/pdf")) {
    const text = await res.text();
    return { ok: false, status: res.status, raw: text };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, pdf: buf };
}

// health
app.get("/", (_, res) => res.send("OK: speedy-proxy is live ✅"));

// sites
app.post("/location/site", async (req, res) => {
  const r = await speedyPost("/location/site/", req.body);
  if (!r.ok) return res.status(500).json(r);
  res.json(r.json);
});

// offices
app.post("/location/office", async (req, res) => {
  const r = await speedyPost("/location/office/", req.body);
  if (!r.ok) return res.status(500).json(r);
  res.json(r.json);
});

// create shipment
app.post("/shipment", async (req, res) => {
  const r = await speedyPost("/shipment/", req.body);
  if (!r.ok) return res.status(500).json(r);
  res.json(r.json);
});

// print label
app.post("/print", async (req, res) => {
  const r = await speedyPostPdf("/print/", req.body);
  if (!r.ok) return res.status(500).json(r);
  res.setHeader("Content-Type", "application/pdf");
  res.send(r.pdf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Speedy proxy running on", PORT));
