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

function getDefaultDropoffOfficeId(body) {
  // Priority: explicit in request -> ENV -> fallback
  const fromReq =
    body?.sender?.dropoffOfficeId ??
    body?.dropoffOfficeId ??
    body?.senderOfficeId ??
    body?.sender_office_id;

  const parsedReq = Number(fromReq);
  if (
    Number.isFinite(parsedReq) &&
    parsedReq > 0 &&
    parsedReq <= 2147483647
  )
    return parsedReq;

  const env = Number(process.env.SPEEDY_DROPOFF_OFFICE_ID);
  if (Number.isFinite(env) && env > 0) return env;

  return 55; // safe fallback (Yambol office in your tests)
}

function normalizeShipmentBody(input = {}) {
  const body = clone(input);

  // unwrap shipment if present
  if (body?.shipment && typeof body.shipment === "object") {
    const { shipment, ...rest } = body;
    return normalizeShipmentBody({ ...rest, ...shipment });
  }

  // Ensure sender object
  body.sender = body.sender || {};

  // Map "senderObjectId"/"sender_object_id" to sender.clientId if present
  if (!body.sender.clientId) {
    const maybeClientId =
      body.senderObjectId ??
      body.sender_object_id ??
      body.senderClientId ??
      body.sender_client_id;

    if (maybeClientId) body.sender.clientId = Number(maybeClientId);
  }

  // 🔥 Fix: If dropoffOfficeId is huge (looks like clientId), move it to clientId and set a real office id.
  const drop = body?.sender?.dropoffOfficeId;
  if (typeof drop === "number" && drop > 2147483647) {
    if (!body.sender.clientId) body.sender.clientId = drop;
    body.sender.dropoffOfficeId = getDefaultDropoffOfficeId(body);
  } else if (typeof drop === "string") {
    const n = Number(drop);
    if (Number.isFinite(n) && n > 2147483647) {
      if (!body.sender.clientId) body.sender.clientId = n;
      body.sender.dropoffOfficeId = getDefaultDropoffOfficeId(body);
    }
  }

  // Ensure we HAVE dropoffOfficeId (MVP office drop-off flow)
  if (!body.sender.dropoffOfficeId) {
    body.sender.dropoffOfficeId = getDefaultDropoffOfficeId(body);
  }

  // ✅ FIX: Speedy rejects sender when BOTH id and name fields are present.
  // If we use sender.clientId, we MUST NOT send sender name/contact/phones/etc.
  if (body?.sender?.clientId) {
    delete body.sender.clientName;
    delete body.sender.contactName;
    delete body.sender.name;
    delete body.sender.phone1;
    delete body.sender.phones;
    delete body.sender.email;
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

  // Content defaults (Speedy required for your contract)
  body.content = body.content || {};
  if (!body.content.package) body.content.package = "BOX";

  // Recipient normalization
  if (body?.recipient) {
    const r = body.recipient;

    // office delivery sometimes rejects contactName/name
    if (r.pickupOfficeId) {
      if ("contactName" in r) delete r.contactName;
      if ("name" in r) delete r.name;
    }

    if (!r.clientName) {
      const first = body?.delivery_first_name || body?.firstName || "";
      const last = body?.delivery_last_name || body?.lastName || "";
      const fallback = `${first} ${last}`.trim();
      r.clientName = fallback || r.name || "CLIENT";
    }

    if (!r.phone1 && typeof r.phone === "string") {
      r.phone1 = { number: r.phone };
      delete r.phone;
    }
  }

  return body;
}

function normalizePrintBody(input = {}) {
  const body = clone(input);

  // Accept old format: { shipments:[id] } and convert to parcels array
  if (Array.isArray(body.shipments) && body.shipments.length > 0) {
    const ids = body.shipments.map((x) => String(x));
    delete body.shipments;
    body.parcels = ids.map((id) => ({ parcel: { id } }));
  }

  // Accept { parcelId } or { id } as fallback
  if (!body.parcels) {
    const maybeId = body.parcelId ?? body.id;
    if (maybeId) body.parcels = [{ parcel: { id: String(maybeId) } }];
  }

  body.paperSize = body.paperSize || "A6";
  body.additionalWaybillSenderCopy =
    body.additionalWaybillSenderCopy || "NONE";

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
  if (
    !ct.includes("application/pdf") &&
    !ct.includes("application/octet-stream")
  ) {
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
  if (!r.ok)
    return res.status(r.status).json(r.json ?? { error: r.raw, sentBody: body });
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
