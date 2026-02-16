import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const SPEEDY_BASE = "https://api.speedy.bg/v1";

function withAuth(body = {}) {
  return {
    userName: body.userName ?? process.env.SPEEDY_USERNAME,
    password: body.password ?? process.env.SPEEDY_PASSWORD,
    language: "BG",
    ...body,
  };
}

// Utility: shallow safe clone
function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function normalizeShipmentBody(input = {}) {
  // Accept either:
  // 1) { sender, recipient, service, content, payment, ... }
  // 2) { shipment: { ... } }
  // 3) { userName, password, shipment: {...} }  (we keep creds at root)
  const body = clone(input);

  // unwrap shipment if present
  if (body?.shipment && typeof body.shipment === "object") {
    const { shipment, ...rest } = body;
    return normalizeShipmentBody({ ...rest, ...shipment });
  }

  // Normalize payer enum
  if (body?.payment?.courierServicePayer === "CONTRACT_CLIENT") {
    body.payment.courierServicePayer = "SENDER";
  }
  const payer = body?.payment?.courierServicePayer;
  if (typeof payer === "string") {
    const p = payer.toUpperCase();
    if (["SENDER", "RECIPIENT", "THIRD_PARTY"].includes(p)) {
      body.payment.courierServicePayer = p;
    }
  }

  // Normalize pickupDate casing (Speedy cares)
  if (body?.service) {
    if (body.service.pickupDate && !body.service.pickUpDate) {
      body.service.pickUpDate = body.service.pickupDate;
      delete body.service.pickupDate;
    }
  }

  // Recipient name rules:
  // Speedy sometimes requires recipient.clientName (id_or_client_name.required)
  // If "clientName" missing, try to fill it from common fields.
  if (body?.recipient) {
    const r = body.recipient;

    // If sending to office, Speedy can complain about contactName in some schemas.
    // We'll keep it only if explicitly needed; default: remove it for office deliveries.
    if (r.pickupOfficeId) {
      if ("contactName" in r) delete r.contactName;
      if ("name" in r) delete r.name; // not used in their strict schema sometimes
    }

    // Fill clientName if missing
    if (!r.clientName) {
      const first = body?.delivery_first_name || body?.firstName || "";
      const last = body?.delivery_last_name || body?.lastName || "";
      const fallback = `${first} ${last}`.trim();
      r.clientName = fallback || r.name || "CLIENT";
    }

    // If phone exists as string somewhere, normalize to { phone1: { number } }
    if (!r.phone1 && typeof r.phone === "string") {
      r.phone1 = { number: r.phone };
      delete r.phone;
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

// contract clients helper (sender clientId / objects)
app.post("/client/contract", async (req, res) => {
  const r = await speedyPost("/client/contract/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// sites
app.post("/location/site", async (req, res) => {
  const r = await speedyPost("/location/site/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// offices by site (helper)
app.post("/location/offices-by-site", async (req, res) => {
  // expects { siteId: <number> }
  const r = await speedyPost("/location/office/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// create shipment
app.post("/shipment", async (req, res) => {
  const body = normalizeShipmentBody(req.body || {});
  const r = await speedyPost("/shipment/", body);

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
