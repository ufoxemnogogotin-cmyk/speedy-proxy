import express from "express";
import cors from "cors";

// ---------------- CONFIG ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// Speedy upstream
const SPEEDY_BASE = "https://api.speedy.bg/v1";

// If you want to force language BG everywhere
const DEFAULT_LANG = "BG";

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

// "гр. Ямбол" -> "Ямбол"
function cleanCityName(name) {
  let s = safeStr(name);
  s = s.replace(/^гр\.\s*/i, "");
  s = s.replace(/^град\s+/i, "");
  return s.trim();
}

function hasSiteId(obj) {
  return !!(obj && (obj.siteId || obj.site?.id || obj.id));
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
        : (data?.error?.message || data?.message || JSON.stringify(data));
    const e = new Error(`Speedy upstream error (${res.status}): ${errMsg}`);
    e.status = res.status;
    e.raw = data;
    throw e;
  }

  return data;
}

// ---------------- SITE RESOLUTION (THE FIX) ----------------
async function resolveSiteId({ userName, password, language, cityName, postCode }) {
  const nameRaw = cleanCityName(cityName);
  const zipRaw = safeStr(postCode);

  // Strategies: try stricter first, then relax
  const attempts = [];

  // 1) name + postCode
  if (nameRaw && zipRaw) {
    attempts.push({ name: nameRaw, postCode: zipRaw });
  }

  // 2) only name
  if (nameRaw) {
    attempts.push({ name: nameRaw, postCode: "" });
  }

  // 3) only postCode
  if (zipRaw) {
    attempts.push({ name: "", postCode: zipRaw });
  }

  // 4) lowercase/uppercase variants for name (Speedy sometimes matches weird)
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
      name: a.name,
      postCode: a.postCode,
    };

    const res = await speedyPost("location/site/", payload);
    lastRes = res;

    const sites = Array.isArray(res) ? res : (res?.sites || res?.result || []);
    if (Array.isArray(sites) && sites.length) {
      // Prefer exact postcode match if we have it
      if (zipRaw) {
        const exact = sites.find(
          (s) => safeStr(s?.postCode) === zipRaw || safeStr(s?.postCode)?.startsWith(zipRaw)
        );
        if (exact?.id) return { id: exact.id, chosen: exact, tried: payload };
      }

      // Otherwise take first
      const first = sites[0];
      if (first?.id) return { id: first.id, chosen: first, tried: payload };
    }
  }

  return { id: 0, chosen: null, tried: attempts, lastRes };
}

// ---------------- NORMALIZATION ----------------
// NOTE: This keeps your current behavior but adds door resolution.
function normalizeShipmentBody(body) {
  const b = body || {};

  // Worker/client might send either:
  // { userName, password, language, recipient, service, content, payment, sender }
  // OR a simplified custom format.
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

  // OFFICE delivery support
  const pickupOfficeId =
    toInt(recipient.pickupOfficeId || b.pickupOfficeId || b.officeId || b.speedyOfficeId || b.receiverOfficeId);

  if (pickupOfficeId) {
    r.pickupOfficeId = pickupOfficeId;
  }

  // DOOR delivery support (addressNote + city/zip)
  const addr = recipient.address || {};
  const addrNote = safeStr(
    addr.addressNote || b.address || b.addressNote || b.receiverAddress || ""
  );

  const cityName = safeStr(b.city || b.receiverCity || addr.city || addr.cityName || "");
  const postCode = safeStr(b.postCode || b.zip || b.receiverZip || addr.postCode || "");

  if (!pickupOfficeId) {
    // door
    r.address = {
      siteId: addr.siteId ? toInt(addr.siteId) : 0,
      postCode: postCode || undefined,
      addressNote: addrNote || undefined,
    };
    // stash for resolver (we'll use these later)
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
    package: safeStr(b.package || "BOX"),
    totalWeight: Number(b.totalWeight || b.weight || 1),
  };

  const payment = b.payment || {
    courierServicePayer: safeStr(b.courierServicePayer || "SENDER"),
  };

  // Sender (optional but useful if you pass it)
  const sender = b.sender ? { ...b.sender } : undefined;

  // Cleanup internal fields later
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
    // Keep original for debugging
    __raw: b,
  };
}

async function enrichRecipientSiteIdIfNeeded(normalized) {
  const r = normalized.recipient;

  // only for door delivery
  if (r?.pickupOfficeId) return normalized;

  const hasAddress = !!r?.address;
  if (!hasAddress) return normalized;

  // If already has siteId => ok
  if (toInt(r.address.siteId) > 0) return normalized;

  const cityName = r.__cityName || "";
  const postCode = r.__postCode || r.address.postCode || "";

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
    const e = new Error(
      `Speedy DOOR: cannot resolve siteId for city="${cityName}" zip="${postCode}".`
    );
    e.details = { cityName, postCode, resolved };
    throw e;
  }

  r.address.siteId = resolved.id;

  // remove internal
  delete r.__cityName;
  delete r.__postCode;

  normalized.__siteResolution = resolved;
  return normalized;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.type("text").send("OK LIVE ✅ speedy-proxy");
});

// passthrough site lookup (optional direct use)
app.post("/location/site", async (req, res) => {
  try {
    const b = req.body || {};
    const payload = {
      userName: safeStr(b.userName || b.username),
      password: safeStr(b.password),
      language: safeStr(b.language || DEFAULT_LANG) || DEFAULT_LANG,
      name: safeStr(b.name || b.city || ""),
      postCode: safeStr(b.postCode || b.zip || ""),
    };
    const data = await speedyPost("location/site/", payload);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({
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
      return res.status(400).json({ error: "Missing userName/password" });
    }

    // Enrich door shipments with siteId
    normalized = await enrichRecipientSiteIdIfNeeded(normalized);

    // Build upstream payload (remove internal debug)
    const upstream = { ...normalized };
    delete upstream.__raw;

    // Send to Speedy
    const data = await speedyPost("shipment/", upstream);

    res.json({
      ok: true,
      data,
      debug: {
        siteResolution: normalized.__siteResolution || null,
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

    const payload = {
      userName,
      password,
      paperSize: safeStr(b.paperSize || "A4"),
      parcels: [{ parcel: { id: parcelId } }],
    };

    const url = `${SPEEDY_BASE}/print/`;
    const upstreamRes = await fetch(url, {
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
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`speedy-proxy listening on :${PORT}`);
});
