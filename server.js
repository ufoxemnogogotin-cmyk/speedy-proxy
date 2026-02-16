import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const SPEEDY_BASE = "https://api.speedy.bg/v1";

function withAuth(body = {}) {
  // Приемаме creds и от request (както ти е в app settings),
  // но ако не са пратени — падаме към ENV (ако решиш после да ги местиш).
  return {
    userName: body.userName ?? process.env.SPEEDY_USERNAME,
    password: body.password ?? process.env.SPEEDY_PASSWORD,
    language: "BG",
    ...body,
  };
}

function normalizeShipmentBody(body = {}) {
  // 1) courierServicePayer мапване (за да не гърми createShipment)
  if (body?.payment?.courierServicePayer === "CONTRACT_CLIENT") {
    body.payment.courierServicePayer = "SENDER";
  }

  // 2) Допускаме и lowercase варианти (ако worker-a е пратил нещо странно)
  const payer = body?.payment?.courierServicePayer;
  if (typeof payer === "string") {
    const p = payer.toUpperCase();
    if (["SENDER", "RECIPIENT", "THIRD_PARTY"].includes(p)) {
      body.payment.courierServicePayer = p;
    }
  }

  return body;
}

async function speedyPost(path, body) {
  const res = await fetch(SPEEDY_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withAuth(body)),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  return { ok: res.ok, status: res.status, json, raw: text };
}

async function speedyPostPdf(path, body) {
  const res = await fetch(SPEEDY_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withAuth(body)),
  });

  const ct = res.headers.get("content-type") || "";
  // Speedy понякога връща application/pdf, понякога application/octet-stream за PDF
  if (!ct.includes("application/pdf") && !ct.includes("application/octet-stream")) {
    const text = await res.text();
    return { ok: false, status: res.status, raw: text };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status, pdf: buf };
}

// health
app.get("/", (_, res) => res.send("OK: speedy-proxy is live ✅"));
app.get("/health", (_, res) => res.json({ ok: true }));

// (Optional helper) Get Contract Clients (за да намериш правилния sender object/clientId)
app.post("/client/contract", async (req, res) => {
  const r = await speedyPost("/client/contract/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  return res.status(200).json(r.json);
});

// sites (ако ти трябва)
app.post("/location/site", async (req, res) => {
  const r = await speedyPost("/location/site/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// offices (ако ти трябва)
app.post("/location/office", async (req, res) => {
  const r = await speedyPost("/location/office/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// create shipment
app.post("/shipment", async (req, res) => {
  const body = normalizeShipmentBody({ ...(req.body || {}) });
  const r = await speedyPost("/shipment/", body);

  // Връщаме реалния status + payload от Speedy (не 500 на всичко)
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// print label (PDF)
app.post("/print", async (req, res) => {
  const r = await speedyPostPdf("/print/", req.body);
  if (!r.ok) return res.status(r.status).send(r.raw);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="speedy-label.pdf"');
  res.send(r.pdf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Speedy proxy running on", PORT));
