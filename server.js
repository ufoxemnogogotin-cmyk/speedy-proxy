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

function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function toIntSafe(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function getDefaultDropoffOfficeId(body) {
  // Priority: explicit in request -> ENV -> fallback
  const fromReq =
    body?.sender?.dropoffOfficeId ??
    body?.dropoffOfficeId ??
    body?.senderOfficeId ??
    body?.sender_office_id ??
    body?.speedy_office_id;

  const parsedReq = toIntSafe(fromReq);
  if (parsedReq && parsedReq > 0 && parsedReq <= 2147483647) return parsedReq;

  const env = toIntSafe(process.env.SPEEDY_DROPOFF_OFFICE_ID);
  if (env && env > 0 && env <= 2147483647) return env;

  return 55; // safe fallback (Yambol office in your tests)
}

function normalizeShipmentBody(input = {}) {
  const body = clone(input);

  // unwrap { shipment: {...} } if present
  if (body?.shipment && typeof body.shipment === "object") {
    const { shipment, ...rest } = body;
    return normalizeShipmentBody({ ...rest, ...shipment });
  }

  body.sender = body.sender || {};
  body.recipient = body.recipient || {};
  body.service = body.service || {};
  body.content = body.content || {};
  body.payment = body.payment || {};

  // ---- sender: map "senderObjectId" (your UI field) -> sender.clientId
  if (!body.sender.clientId) {
    const maybeClientId =
      body.senderObjectId ??
      body.sender_object_id ??
      body.senderClientId ??
      body.sender_client_id ??
      body.senderId ??
      body.sender_id;

    const cid = toIntSafe(maybeClientId);
    if (cid) body.sender.clientId = cid;
  } else {
    body.sender.clientId = toIntSafe(body.sender.clientId);
  }

  // ---- 🔥 The exact bug: clientId accidentally passed as dropoffOfficeId
  const drop = body.sender.dropoffOfficeId;
  const dropN = toIntSafe(drop);

  if (dropN && dropN > 2147483647) {
    // looks like a clientId, not an officeId
    if (!body.sender.clientId) body.sender.clientId = dropN;
    body.sender.dropoffOfficeId = getDefaultDropoffOfficeId(body);
  } else if (dropN) {
    body.sender.dropoffOfficeId = dropN;
  }

  // ---- Office MVP: ensure dropoffOfficeId exists (so we don't trigger address pickup rules)
  if (!body.sender.dropoffOfficeId) {
    body.sender.dropoffOfficeId = getDefaultDropoffOfficeId(body);
  }

  // ---- Speedy rule: if sender has clientId/id -> sender.privatePerson MUST NOT be present/true
  // Also remove sender names when clientId is provided (Speedy gets picky)
  if (body.sender.clientId) {
    if ("privatePerson" in body.sender) delete body.sender.privatePerson;
    if ("clientName" in body.sender) delete body.sender.clientName;
    if ("name" in body.sender) delete body.sender.name;
    if ("contactName" in body.sender) delete body.sender.contactName;
  }

  // ---- Normalize payer enum
  if (body.payment?.courierServicePayer === "CONTRACT_CLIENT") {
    body.payment.courierServicePayer = "SENDER";
  }
  if (typeof body.payment?.courierServicePayer === "string") {
    const p = body.payment.courierServicePayer.toUpperCase();
    if (["SENDER", "RECIPIENT", "THIRD_PARTY"].includes(p)) body.payment.courierServicePayer = p;
  }

  // ---- Normalize pickupDate casing (Speedy expects pickUpDate)
  if (body.service.pickupDate && !body.service.pickUpDate) {
    body.service.pickUpDate = body.service.pickupDate;
    delete body.service.pickupDate;
  }

  // ---- Content defaults (required in your contract tests)
  if (!body.content.package) body.content.package = "BOX";

  // ---- Recipient normalization
  // For office deliveries Speedy often hates "contactName" and sometimes "name"
  if (body.recipient.pickupOfficeId) {
    if ("contactName" in body.recipient) delete body.recipient.contactName;
    if ("name" in body.recipient) delete body.recipient.name;
  }

  // Ensure recipient.clientName exists
  if (!body.recipient.clientName) {
    const fallback =
      (body.delivery_first_name || body.firstName || "").toString().trim() +
      " " +
      (body.delivery_last_name || body.lastName || "").toString().trim();
    body.recipient.clientName = fallback.trim() || "CLIENT";
  }

  // Normalize recipient phone
  if (!body.recipient.phone1 && typeof body.recipient.phone === "string") {
    body.recipient.phone1 = { number: body.recipient.phone };
    delete body.recipient.phone;
  }

  return body;
}

function normalizePrintBody(input = {}) {
  const body = clone(input);

  // Accept shipments:[id] -> convert to parcels:[{parcel:{id}}]
  if (Array.isArray(body.shipments) && body.shipments.length > 0) {
    const ids = body.shipments.map((x) => String(x));
    delete body.shipments;
    body.parcels = ids.map((id) => ({ parcel: { id } }));
  }

  // If parcelId/id is given
  if (!body.parcels) {
    const maybeId = body.parcelId ?? body.id;
    if (maybeId) body.parcels = [{ parcel: { id: String(maybeId) } }];
  }

  body.paperSize = body.paperSize || "A6";
  body.additionalWaybillSenderCopy = body.additionalWaybillSenderCopy || "NONE";
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
  if (!ct.includes("application/pdf") && !ct.includes("application/octet-stream")) {
    const text = await res.text();
    return { ok: false, status: res.status, raw: text, contentType: ct };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status, pdf: buf, contentType: ct };
}

// health
app.get("/", (_, res) => res.send("OK: speedy-proxy is live ✅"));
app.get("/health", (_, res) => res.json({ ok: true }));

// contract clients
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

// offices by site
app.post("/location/offices-by-site", async (req, res) => {
  const r = await speedyPost("/location/office/", req.body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw });
  res.json(r.json);
});

// create shipment
app.post("/shipment", async (req, res) => {
  const body = normalizeShipmentBody(req.body || {});
  const r = await speedyPost("/shipment/", body);
  if (!r.ok) return res.status(r.status).json(r.json ?? { error: r.raw, sentBody: body });
  res.json(r.json);
});

// print label (PDF)
app.post("/print", async (req, res) => {
  const body = normalizePrintBody(req.body || {});
  const r = await speedyPostPdf("/print/", body);

  if (!r.ok) {
    return res.status(r.status).json({
      error: "Speedy did not return PDF",
      contentType: r.contentType,
      raw: r.raw,
      sentBody: body,
    });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="speedy-label.pdf"');
  res.send(r.pdf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Speedy proxy running on", PORT));
