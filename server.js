import express from "express";
import cors from "cors";

// ---------------- CONFIG ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// Speedy upstream
const SPEEDY_BASE = "https://api.speedy.bg/v1";

// Force language BG by default
const DEFAULT_LANG = "BG";

// Над тази сума доставката е за сметка на подателя
const DEFAULT_FREE_OVER_EUR = Number(process.env.SPEEDY_FREE_OVER_EUR || 0);

// ---------------- UTILS ----------------
function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function toInt(x) {
  const n = Number(String(x ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function toMoney(x) {
  const n = Number(String(x ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

function pickOrderTotal(b, service) {
  return toMoney(
    b.orderTotal ??
    b.totalAmount ??
    b.total ??
    b.codAmount ??
    service?.additionalServices?.cod?.amount ??
    0
  );
}

function applyFreeShippingPayerRule({ body, service, payment }) {
  const freeOver = toMoney(body.freeShippingOverEur ?? body.freeOverEur ?? DEFAULT_FREE_OVER_EUR);
  const orderTotal = pickOrderTotal(body, service);

  const isFreeShipping = freeOver > 0 && orderTotal >= freeOver;

  // под 100 EUR -> получател
  // над/равно 100 EUR -> подател
  payment.courierServicePayer = isFreeShipping ? "SENDER" : "RECIPIENT";

  return {
    freeOver,
    orderTotal,
    isFreeShipping,
    courierServicePayer: payment.courierServicePayer,
  };
}

// "гр. Ямбол" -> "Ямбол"
function cleanCityName(name) {
  let s = safeStr(name);
  s = s.replace(/^гр\.\s*/i, "");
  s = s.replace(/^град\s+/i, "");
  return s.trim();
}

// Speedy sometimes returns {id} or {siteId} or {site:{id}}
function pickSiteId(obj) {
  const v = obj?.id ?? obj?.siteId ?? obj?.site?.id;
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function extractSitesList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.sites)) return res.sites;
  if (Array.isArray(res?.result)) return res.result;
  if (Array.isArray(res?.data)) return res.data;
  return [];
}

// Normalize payer enum (Speedy expects SENDER/RECIPIENT/THIRD_PARTY)
function normalizeCourierServicePayer(x) {
  const v = safeStr(x).toUpperCase();
  if (!v) return "SENDER";

  // already valid
  if (v === "SENDER" || v === "RECIPIENT" || v === "THIRD_PARTY") return v;

  // common "wrong" values -> map safely to SENDER
  if (v === "CONTRACT_CLIENT" || v === "CLIENT" || v === "CONTRACT" || v === "SENDER_CLIENT") return "SENDER";

  // sometimes people send "receiver"
  if (v === "RECEIVER") return "RECIPIENT";

  // fallback
  return "SENDER";
}

function isPaidOnline(body) {
  const b = body || {};

  const financialStatus = safeStr(
    b.financialStatus ||
      b.paymentStatus ||
      b.shopifyFinancialStatus ||
      b.financial_status ||
      b.order?.financial_status ||
      b.order?.financialStatus ||
      ""
  ).toLowerCase();

  const paymentMethod = safeStr(
    b.paymentMethod ||
      b.gateway ||
      b.paymentGateway ||
      b.payment_gateway ||
      b.order?.gateway ||
      b.order?.payment_gateway_names?.join(" ") ||
      ""
  ).toLowerCase();

  return (
    financialStatus === "paid" ||
    financialStatus === "partially_paid" ||
    paymentMethod.includes("card") ||
    paymentMethod.includes("stripe") ||
    paymentMethod.includes("shopify payments") ||
    paymentMethod.includes("paypal")
  );
}

function cleanupSpeedyPaidOnlineService(service) {
  if (!service?.additionalServices) return service;

  // Платено онлайн = НЕ пращаме наложен платеж и НЕ пращаме опции преди плащане
  delete service.additionalServices.cod;
  delete service.additionalServices.obpd;

  if (Object.keys(service.additionalServices).length === 0) {
    delete service.additionalServices;
  }

  return service;
}

function cleanupObpdForPickupOffice(service, recipient) {
  if (!service?.additionalServices) return service;

  // Speedy не позволява obpd при АПС/автомат.
  // Понеже при pickupOfficeId не винаги знаем дали е офис или автомат,
  // махаме obpd като safety net, за да не гърми товарителницата.
  if (recipient?.pickupOfficeId && service.additionalServices.obpd) {
    delete service.additionalServices.obpd;
  }

  if (Object.keys(service.additionalServices).length === 0) {
    delete service.additionalServices;
  }

  return service;
}

// ---------------- SPEEDY CORE CALL ----------------
async function speedyPost(endpoint, payload) {
  const url = `${SPEEDY_BASE}/${endpoint.replace(/^\/+/, "")}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();

  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    data = txt;
  }

  if (!res.ok) {
    const errMsg =
      typeof data === "string"
        ? data
        : data?.error?.message || data?.message || JSON.stringify(data);

    const e = new Error(`Speedy upstream error (${res.status}): ${errMsg}`);
    e.status = res.status;
    e.raw = data;
    throw e;
  }

  // ВАЖНО:
  // Speedy понякога връща HTTP 200, но вътре има error.
  // Това НЕ трябва да минава като успешна заявка.
  if (data && typeof data === "object" && data.error) {
    const e = new Error(data.error.message || JSON.stringify(data.error));
    e.status = 422;
    e.raw = data;
    e.speedyError = data.error;
    throw e;
  }

  return data;
}

// ---------------- SITE RESOLUTION ----------------
async function resolveSiteId({ userName, password, language, cityName, postCode }) {
  const nameRaw = cleanCityName(cityName);
  const zipRaw = safeStr(postCode);

  const attempts = [];

  // 1) name + postCode
  if (nameRaw && zipRaw) attempts.push({ name: nameRaw, postCode: zipRaw });

  // 2) only name
  if (nameRaw) attempts.push({ name: nameRaw, postCode: "" });

  // 3) only postCode
  if (zipRaw) attempts.push({ name: "", postCode: zipRaw });

  // 4) case variants (Speedy sometimes matches weird)
  if (nameRaw) {
    attempts.push({ name: nameRaw.toUpperCase(), postCode: zipRaw || "" });
    attempts.push({ name: nameRaw.toLowerCase(), postCode: zipRaw || "" });
  }

  let lastRes = null;

  for (const a of attempts) {
const payload = {
  userName,
  password,
  language: language || DEFAULT_LANG,
  countryId: 100, // ✅ BG (Speedy)
  name: a.name,
  postCode: a.postCode,
};

    const res = await speedyPost("location/site/", payload);
    lastRes = res;

    const sites = extractSitesList(res);

    if (sites.length) {
      // Prefer exact postcode match
      if (zipRaw) {
        const exact = sites.find(
          (s) => safeStr(s?.postCode) === zipRaw || safeStr(s?.postCode)?.startsWith(zipRaw)
        );
        const exactId = pickSiteId(exact);
        if (exactId) return { id: exactId, chosen: exact, tried: payload, sitesCount: sites.length };
      }

      const first = sites[0];
      const firstId = pickSiteId(first);
      if (firstId) return { id: firstId, chosen: first, tried: payload, sitesCount: sites.length };
    }
  }

  return { id: 0, chosen: null, tried: attempts, lastRes };
}

// ---------------- NORMALIZATION ----------------
function normalizeShipmentBody(body) {
  const b = body || {};

  const userName = safeStr(b.userName || b.username || b.user || b.UserName);
  const password = safeStr(b.password || b.pass || b.Password);
  const language = safeStr(b.language || DEFAULT_LANG) || DEFAULT_LANG;

  // Recipient base
  const recipient = b.recipient || {};
  const r = {
    privatePerson: recipient.privatePerson ?? true,
    clientName: safeStr(recipient.clientName || b.receiverName || b.recipientName || "—"),
    phone1: recipient.phone1 || (b.receiverPhone ? { number: safeStr(b.receiverPhone) } : undefined),
  };

  // OFFICE delivery
  const pickupOfficeId = toInt(
    recipient.pickupOfficeId ||
      b.pickupOfficeId ||
      b.officeId ||
      b.speedyOfficeId ||
      b.receiverOfficeId
  );
  if (pickupOfficeId) r.pickupOfficeId = pickupOfficeId;

  // DOOR delivery
  const addr = recipient.address || {};

  const addrNote = safeStr(addr.addressNote || b.address || b.addressNote || b.receiverAddress || "");

  // IMPORTANT: accept city/postcode from multiple places:
  const cityName = safeStr(
    b.city || b.cityName || b.receiverCity || addr.cityName || addr.city || addr.name || ""
  );
  const postCode = safeStr(
    b.postCode || b.zip || b.receiverZip || addr.postCode || addr.zip || ""
  );

  if (!pickupOfficeId) {
    r.address = {
      siteId: pickSiteId(addr) || toInt(addr.siteId) || 0,
      postCode: postCode || undefined,
      addressNote: addrNote || undefined,
    };

    // stash for resolver
    r.__cityName = cityName;
    r.__postCode = postCode;
  }

  // Service / Content / Payment
  const service = b.service || {
    serviceId: toInt(b.serviceId) || 505,
    autoAdjustPickupDate: true,
  };

  const content = b.content || {
    parcelsCount: toInt(b.parcelsCount) || 1,
    contents: safeStr(b.contents || b.contentDescription || "Online order"),
    package: safeStr(b.package || "ПЛИК"),
    totalWeight: Number(b.totalWeight || b.weight || 1),
  };

const payment = b.payment ? { ...b.payment } : {};

payment.courierServicePayer = normalizeCourierServicePayer(
  payment.courierServicePayer || b.courierServicePayer || "RECIPIENT"
);

const paidOnline = isPaidOnline(b);

let paymentDebug;

if (paidOnline) {
  // Платена с карта/онлайн поръчка:
  // - махаме COD
  // - махаме OBPD
  // - доставката е за подателя, защото клиентът вече е платил онлайн
  cleanupSpeedyPaidOnlineService(service);
  payment.courierServicePayer = "SENDER";

  paymentDebug = {
    paidOnline: true,
    rule: "paid_online_removes_cod_obpd_and_sets_sender_payer",
    courierServicePayer: payment.courierServicePayer,
  };
} else {
  paymentDebug = applyFreeShippingPayerRule({
    body: b,
    service,
    payment,
  });
}

  const sender = b.sender ? { ...b.sender } : undefined;

  return {
    userName,
    password,
    language,
    sender,
    recipient: r,
    service,
    content,
    payment,
    ref1: safeStr(b.ref1 || b.reference1 || ""),
    ref2: safeStr(b.ref2 || b.reference2 || ""),
    consolidationRef: safeStr(b.consolidationRef || ""),
    __raw: b,
    __paymentDebug: paymentDebug,
  };
}

async function enrichRecipientSiteIdIfNeeded(normalized) {
  const r = normalized.recipient;

  // only for door delivery
  if (r?.pickupOfficeId) return normalized;
  if (!r?.address) return normalized;

  // already has siteId
  if (toInt(r.address.siteId) > 0) return normalized;

  const cityName = safeStr(r.__cityName || "");
  const postCode = safeStr(r.__postCode || r.address.postCode || "");

  if (!cityName && !postCode) {
    const e = new Error("Speedy DOOR: missing city/postcode for siteId resolution.");
    e.details = { cityName, postCode };
    throw e;
  }

  const resolved = await resolveSiteId({
    userName: normalized.userName,
    password: normalized.password,
    language: normalized.language,
    cityName,
    postCode,
  });

  if (!resolved.id) {
    const e = new Error(`Speedy DOOR: cannot resolve siteId for city="${cityName}" zip="${postCode}".`);
    e.details = { cityName, postCode, resolved };
    throw e;
  }

  r.address.siteId = resolved.id;

  delete r.__cityName;
  delete r.__postCode;

  normalized.__siteResolution = resolved;
  return normalized;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.type("text").send("OK LIVE ✅ speedy-proxy");
});

// passthrough site lookup
app.post("/location/site", async (req, res) => {
  try {
    const b = req.body || {};
const payload = {
  userName: safeStr(b.userName || b.username),
  password: safeStr(b.password),
  language: safeStr(b.language || DEFAULT_LANG) || DEFAULT_LANG,
  countryId: toInt(b.countryId) || 100, // ✅ allow override, default BG
  name: cleanCityName(safeStr(b.name || b.city || "")),
  postCode: safeStr(b.postCode || b.zip || ""),
};

    const data = await speedyPost("location/site/", payload);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message || String(e),
      details: e.raw || e.details || null,
    });
  }
});

// MAIN: create shipment
app.post("/shipment", async (req, res) => {
  try {
    let normalized = normalizeShipmentBody(req.body);

    if (!normalized.userName || !normalized.password) {
      return res.status(400).json({ ok: false, error: "Missing userName/password" });
    }

    // enrich door shipments with siteId
    normalized = await enrichRecipientSiteIdIfNeeded(normalized);

    // SAFETY FIX:
    // Ако е до pickupOfficeId и някъде по веригата е добавено obpd,
    // го махаме преди Speedy, защото АПС/автомат + obpd гърми.
    cleanupObpdForPickupOffice(normalized.service, normalized.recipient);

    // upstream payload (strip internal)
    const upstream = { ...normalized };
    delete upstream.__raw;
    delete upstream.__siteResolution;
    delete upstream.__paymentDebug;

    // TEMP DEBUG:
    // Остави това временно, за да видиш реалния payload към Speedy.
    // После може да го махнеш.
    console.log(
      "SPEEDY UPSTREAM PAYLOAD",
      JSON.stringify(
        {
          ...upstream,
          password: "***",
        },
        null,
        2
      )
    );

    // send to Speedy
    const data = await speedyPost("shipment/", upstream);

    res.json({
      ok: true,
      data,
      debug: {
        siteResolution: normalized.__siteResolution || null,
        payment: normalized.__paymentDebug || null,
      },
    });
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message || String(e),
      details: e.raw || e.details || null,
    });
  }
});

// Print PDF
app.post("/print", async (req, res) => {
  try {
    const b = req.body || {};
    const userName = safeStr(b.userName || b.username);
    const password = safeStr(b.password);
    const parcelId = safeStr(b.parcelId || b.id || "");

    if (!userName || !password || !parcelId) {
      return res.status(400).send("Missing userName/password/parcelId");
    }

const requestedPaperSize = safeStr(b.paperSize || "A6");

const paperSize = ["A4", "A6", "A4_4xA6"].includes(requestedPaperSize)
  ? requestedPaperSize
  : "A6";

const payload = {
  userName,
  password,
  language: safeStr(b.language || DEFAULT_LANG) || DEFAULT_LANG,
  format: "pdf",
  paperSize,
  parcels: [{ parcel: { id: parcelId } }],
};

    const upstreamRes = await fetch(`${SPEEDY_BASE}/print/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!upstreamRes.ok) {
      const t = await upstreamRes.text();
      return res.status(upstreamRes.status).send(t);
    }

    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    res.setHeader("content-type", "application/pdf");
    res.setHeader("cache-control", "no-store");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`speedy-proxy listening on :${PORT}`);
});
