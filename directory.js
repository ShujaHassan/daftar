import { extractFromHtml, fetchText, findPublicPages, platformOf } from "./scraper.js";

const UA = "DAFTAR/1.0 (public business directory research)";
const MAX_RESULTS = 80;
const LOOKUP_LIMIT = 80;

const CATEGORIES = [
  {
    keys: ["beverage", "beverages", "drink", "drinks", "juice", "soda", "soft drink", "cold drink"],
    names: ["beverage", "juice", "drink", "soda", "cola", "squash"],
    tags: [
      ["shop", "beverages"],
      ["shop", "alcohol"],
      ["shop", "wine"],
      ["shop", "tea"],
      ["craft", "brewery"],
    ],
  },
  {
    keys: ["restaurant", "restaurants", "food", "dhaba"],
    names: ["restaurant"],
    tags: [
      ["amenity", "restaurant"],
      ["amenity", "fast_food"],
    ],
  },
  {
    keys: ["cafe", "coffee"],
    names: ["cafe", "coffee"],
    tags: [
      ["amenity", "cafe"],
      ["shop", "coffee"],
    ],
  },
  {
    keys: ["pharmacy", "pharmacies", "medical store", "chemist", "drugstore"],
    names: ["pharmacy", "chemist"],
    tags: [["amenity", "pharmacy"]],
  },
  {
    keys: ["hospital", "hospitals", "clinic", "clinics"],
    names: ["hospital", "clinic"],
    tags: [
      ["amenity", "hospital"],
      ["amenity", "clinic"],
      ["amenity", "doctors"],
    ],
  },
  {
    keys: ["hotel", "hotels", "guest house"],
    names: ["hotel"],
    tags: [
      ["tourism", "hotel"],
      ["tourism", "guest_house"],
    ],
  },
  {
    keys: ["gym", "fitness"],
    names: ["gym", "fitness"],
    tags: [
      ["leisure", "fitness_centre"],
      ["leisure", "sports_centre"],
    ],
  },
  {
    keys: ["school", "schools"],
    names: ["school"],
    tags: [["amenity", "school"]],
  },
  {
    keys: ["bank", "banks"],
    names: ["bank"],
    tags: [["amenity", "bank"]],
  },
  {
    keys: ["supermarket", "grocery", "mart", "kiryana"],
    names: ["supermarket", "grocery", "mart"],
    tags: [
      ["shop", "supermarket"],
      ["shop", "convenience"],
      ["shop", "general"],
    ],
  },
  {
    keys: ["bakery", "bakeries"],
    names: ["bakery"],
    tags: [["shop", "bakery"]],
  },
  {
    keys: ["clothing", "clothes", "garment", "fashion"],
    names: ["garment", "cloth"],
    tags: [["shop", "clothes"]],
  },
  {
    keys: ["electronics", "mobile", "phone shop"],
    names: ["electronic", "mobile"],
    tags: [
      ["shop", "electronics"],
      ["shop", "mobile_phone"],
    ],
  },
  {
    keys: ["salon", "saloon", "barber", "beauty"],
    names: ["salon", "barber"],
    tags: [
      ["shop", "beauty"],
      ["shop", "hairdresser"],
    ],
  },
  {
    keys: ["petrol", "fuel", "gas station"],
    names: ["petrol", "fuel"],
    tags: [["amenity", "fuel"]],
  },
];

export async function searchDirectory({ country, city, keyword }, options = {}) {
  const placeName = cleanLabel(city);
  const countryName = cleanLabel(country);
  const term = cleanKeyword(keyword);
  if (!placeName || !countryName) throw new Error("Country aur city select karo.");
  if (!term) throw new Error("Business type likho, jaise beverages.");

  const signal = options.signal;
  const emit = options.onEvent || (() => {});
  emit({ message: `${placeName}, ${countryName} dhoondh raha hoon…` });
  const place = await geocode(placeName, countryName, signal);
  const category = CATEGORIES.find((item) => item.keys.some((key) => matches(term, key)));
  emit({ message: `${placeName} mein “${term}” ki public listings dekh raha hoon…` });
  const rows = await discover(place, term, category, signal);
  const businesses = dedupe(rows.map((row) => toBusiness(row, placeName)).filter((row) => row.name)).slice(0, MAX_RESULTS);

  const withSites = businesses.filter((row) => row.website);
  if (withSites.length) {
    emit({ message: `${withSites.length} websites se number aur social links nikal raha hoon…` });
    await enrichSites(withSites, signal, emit);
  }
  const needsLookup = businesses.filter((row) => !row.phone || !row.social.length).slice(0, LOOKUP_LIMIT);
  if (needsLookup.length) {
    emit({ message: `${needsLookup.length} businesses ka public number aur social dhoondh raha hoon…` });
    await lookupPublic(needsLookup, placeName, signal, emit);
  }

  businesses.sort((a, b) => detailScore(b) - detailScore(a) || a.name.localeCompare(b.name));
  const notes = [];
  if (!businesses.length) {
    notes.push("Is city ke public listings mein yeh business type nahi mila. Spelling ya koi aur city try karo.");
  } else {
    notes.push("Number, email, aur social link tabhi aate hain jab woh map listing ya kisi public page par likhe hon. Login ke peeche ka data nahi aata.");
    const missing = businesses.filter((row) => !row.phone && !row.social.length).length;
    if (missing) notes.push(`${missing} businesses ka number ya social public pages par nahi mila.`);
  }
  return {
    kind: "directory",
    country: countryName,
    city: placeName,
    keyword: term,
    area: place.display,
    count: businesses.length,
    businesses,
    notes,
  };
}

async function geocode(city, country, signal) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("q", `${city}, ${country}`);
  const response = await fetch(url, {
    signal,
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!response.ok) throw new Error("City lookup fail ho gayi. Dobara try karo.");
  const rows = await response.json();
  const hit = rows?.[0];
  if (!hit) throw new Error("Yeh city is country mein nahi mili.");
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("City ka location nahi mila.");
  const box = Array.isArray(hit.boundingbox) ? hit.boundingbox.map(Number) : [];
  const span = box.length === 4 ? Math.max(Math.abs(box[1] - box[0]), Math.abs(box[3] - box[2])) : 0.2;
  const radius = Math.round(Math.min(Math.max(span * 111000 * 0.55, 6000), 20000));
  const bbox = box.length === 4 && span > 0.02 && span < 0.8
    ? { south: box[0], west: box[2], north: box[1], east: box[3] }
    : null;
  return {
    lat,
    lon,
    radius,
    bbox,
    city,
    display: hit.display_name || `${city}, ${country}`,
  };
}

async function discover(place, keyword, category, signal) {
  const terms = unique([keyword, ...(category?.names || [])]).slice(0, 4);
  const named = [];
  for (const term of terms) named.push(...await photonSearch(`${term} ${place.city}`, place, signal));
  const tagged = await overpassTags(place, category, signal);
  const details = await overpassByIds(named, signal);
  const byId = new Map(details.map((element) => [`${element.type}:${element.id}`, element]));
  const rows = [];
  for (const item of named) {
    const known = byId.get(`${osmType(item.osmType)}:${item.osmId}`);
    if (known) rows.push(known);
    else {
      rows.push({
        type: osmType(item.osmType),
        id: item.osmId,
        lat: item.lat,
        lon: item.lon,
        tags: {
          name: item.name,
          [item.key || "shop"]: item.value || "yes",
          "addr:street": item.street || "",
          "addr:housenumber": item.housenumber || "",
          "addr:city": item.city || place.city,
        },
      });
    }
  }
  rows.push(...tagged);
  return rows;
}

async function photonSearch(query, place, signal) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("lat", String(place.lat));
  url.searchParams.set("lon", String(place.lon));
  url.searchParams.set("limit", "20");
  let response;
  try {
    response = await fetch(url, { signal, headers: { "user-agent": UA, accept: "application/json" } });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const payload = await response.json();
  const rows = [];
  for (const feature of payload.features || []) {
    const props = feature.properties || {};
    const [lon, lat] = feature.geometry?.coordinates || [];
    if (!props.name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (distanceKm(place.lat, place.lon, lat, lon) > 30) continue;
    if (!props.osm_id || !props.osm_type) continue;
    rows.push({
      name: props.name,
      key: props.osm_key,
      value: props.osm_value,
      street: props.street,
      housenumber: props.housenumber,
      city: props.city,
      osmId: props.osm_id,
      osmType: props.osm_type,
      lat,
      lon,
    });
  }
  return rows;
}

async function overpassTags(place, category, signal) {
  if (!category?.tags?.length) return [];
  const area = `(around:${Math.min(place.radius, 18000)},${place.lat},${place.lon})`;
  const filters = category.tags.map(([key, value]) => `nwr["${key}"="${value}"]${area};`);
  return overpassElements(`[out:json][timeout:20];\n(\n${filters.join("\n")}\n);\nout tags center ${MAX_RESULTS};`, signal);
}

async function overpassByIds(items, signal) {
  const groups = { N: [], W: [], R: [] };
  for (const item of items) {
    const bucket = groups[String(item.osmType || "").toUpperCase()];
    if (bucket && item.osmId) bucket.push(item.osmId);
  }
  const lines = [];
  if (groups.N.length) lines.push(`node(id:${uniqueNumbers(groups.N).join(",")});`);
  if (groups.W.length) lines.push(`way(id:${uniqueNumbers(groups.W).join(",")});`);
  if (groups.R.length) lines.push(`relation(id:${uniqueNumbers(groups.R).join(",")});`);
  if (!lines.length) return [];
  return overpassElements(`[out:json][timeout:20];\n(\n${lines.join("\n")}\n);\nout tags center;`, signal);
}

async function overpassElements(query, signal) {
  let response;
  try {
    response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      signal,
      headers: {
        "user-agent": UA,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `data=${encodeURIComponent(query)}`,
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload.elements) ? payload.elements : [];
}

function osmType(value) {
  if (value === "N") return "node";
  if (value === "W") return "way";
  if (value === "R") return "relation";
  return String(value || "");
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111;
  const dLon = (lon2 - lon1) * 111 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function uniqueNumbers(list) {
  return [...new Set(list.map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
}

function toBusiness(element, city) {
  const tags = element.tags || {};
  const businessLike = tags.shop || tags.amenity || tags.office || tags.craft || tags.tourism || tags.leisure || tags.phone || tags.website;
  if (!businessLike || tags.highway || tags.natural || tags.landuse || tags.waterway) {
    return { name: "" };
  }
  const lat = element.lat || element.center?.lat;
  const lon = element.lon || element.center?.lon;
  const address = tidyAddress([
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"] || city,
    tags["addr:postcode"],
  ]);
  const phones = uniquePhones(phoneList(tags));
  const social = socialFromTags(tags, phones);
  let website = cleanSite(tags.website || tags["contact:website"] || tags.url || "");
  const sitePlatform = website && platformOf(website);
  if (sitePlatform) {
    pushSocial(social, sitePlatform, website);
    website = "";
  }
  return {
    name: tags.name || tags["name:en"] || tags.brand || "",
    category: labelCategory(tags),
    address,
    phone: phones[0] || "",
    phones,
    email: tags.email || tags["contact:email"] || "",
    emails: uniqueText([tags.email, tags["contact:email"]]),
    website,
    social,
    hours: tags.opening_hours || "",
    maps: Number.isFinite(lat) && Number.isFinite(lon) ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` : "",
  };
}

const SOCIAL_FIELDS = [
  ["facebook", "Facebook", "https://www.facebook.com/"],
  ["contact:facebook", "Facebook", "https://www.facebook.com/"],
  ["instagram", "Instagram", "https://www.instagram.com/"],
  ["contact:instagram", "Instagram", "https://www.instagram.com/"],
  ["twitter", "X", "https://x.com/"],
  ["contact:twitter", "X", "https://x.com/"],
  ["youtube", "YouTube", "https://www.youtube.com/"],
  ["contact:youtube", "YouTube", "https://www.youtube.com/"],
  ["tiktok", "TikTok", "https://www.tiktok.com/@"],
  ["contact:tiktok", "TikTok", "https://www.tiktok.com/@"],
  ["linkedin", "LinkedIn", "https://www.linkedin.com/company/"],
  ["contact:linkedin", "LinkedIn", "https://www.linkedin.com/company/"],
];

function phoneList(tags) {
  const raw = [tags.phone, tags["contact:phone"], tags.mobile, tags["contact:mobile"], tags["phone:mobile"]];
  const out = [];
  for (const item of raw) {
    for (const part of String(item || "").split(/[;,]|\s+or\s+/i)) {
      const phone = tidyPhone(part);
      if (phone) out.push(phone);
    }
  }
  return uniquePhones(out);
}

function socialFromTags(tags, phones) {
  const social = [];
  for (const [key, platform, base] of SOCIAL_FIELDS) {
    const url = asSocialUrl(base, tags[key]);
    if (url) pushSocial(social, platform, url);
  }
  const whatsapp = String(tags["contact:whatsapp"] || tags.whatsapp || "").trim();
  if (whatsapp) {
    const phone = tidyPhone(whatsapp);
    if (phone) phones.push(phone);
    const digits = (phone || whatsapp).replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) pushSocial(social, "WhatsApp", `https://wa.me/${digits}`);
  }
  return social;
}

function asSocialUrl(base, raw) {
  const value = String(raw || "").trim();
  if (!value || /^yes$/i.test(value)) return "";
  if (/^https?:\/\//i.test(value)) {
    const site = cleanSite(value);
    if (!site || isUselessProfile(site)) return "";
    return site;
  }
  const handle = value.replace(/^@/, "").split(/[/?#\s]/)[0];
  if (!/^[\w.\-]{2,80}$/.test(handle)) return "";
  return base + handle;
}

async function enrichSites(rows, signal, emit) {
  let done = 0;
  await runPool(rows, 4, async (row) => {
    await readSite(row, signal);
    done += 1;
    if (done === rows.length || done % 4 === 0) emit({ message: `${done}/${rows.length} websites padh li…` });
  });
}

async function readSite(row, signal) {
  if (!row?.website) return;
  try {
    const page = await fetchText(row.website, signal, new Map(), 8000);
    if (!page.html) return;
    const extracted = extractFromHtml(page.html, page.url);
    applyExtract(row, extracted);
    if (row.phone && row.social.length) return;
    const contact = contactUrl(page.url, extracted.links);
    if (!contact) return;
    const extra = await fetchText(contact, signal, new Map(), 7000);
    if (extra.html) applyExtract(row, extractFromHtml(extra.html, extra.url));
  } catch {
    /* a blocked website still stays in the list with the details we already have */
  }
}

async function lookupPublic(rows, city, signal, emit) {
  let done = 0;
  await runPool(rows, 3, async (row) => {
    try {
      const tokens = nameTokens(row.name);
      if (tokens.length) {
        const links = await findPublicPages(`"${row.name}" ${city}`, signal, new Map(), 8000);
        const matched = links.filter((link) => mentions(link, tokens));
        for (const link of matched) {
          const platform = platformOf(link);
          if (platform && !isUselessProfile(link)) pushSocial(row.social, platform, stripHash(link));
        }
        if (!row.website) {
          const site = matched.find((link) => !platformOf(link) && !isListingHost(link));
          if (site) row.website = site;
        }
        if (row.website && (!row.phone || !row.social.length)) await readSite(row, signal);
        const wa = row.social.find((item) => item.platform === "WhatsApp");
        if (wa && !row.phones.length) {
          const digits = (wa.url.match(/wa\.me\/(\d{8,15})/) || [])[1];
          if (digits) mergePhones(row, ["+" + digits]);
        }
      }
    } catch {
      /* this business keeps the public details already collected */
    }
    done += 1;
    emit({ message: `${row.name}: public detail check ho gayi (${done}/${rows.length})` });
  });
}

function applyExtract(row, extracted) {
  mergePhones(row, extracted.phones.map((item) => item.value));
  const emails = extracted.emails.map((item) => item.value);
  row.emails = uniqueText([...(row.emails || []), ...emails]);
  if (!row.email && row.emails[0]) row.email = row.emails[0];
  for (const item of extracted.socials || []) pushSocial(row.social, item.platform, item.url);
  if (!row.hours && extracted.hours[0]) row.hours = extracted.hours[0];
  if (!row.address && extracted.addresses[0]) row.address = extracted.addresses[0];
  if (extracted.description && !row.about) row.about = extracted.description;
}

function contactUrl(pageUrl, links) {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return "";
  }
  for (const link of links || []) {
    try {
      const url = new URL(link.href);
      if (url.origin !== origin) continue;
      if (/^\/(contact|contact-us|contactus)\/?$/i.test(url.pathname)) return url.href;
    } catch {
      /* skip bad hrefs */
    }
  }
  return "";
}

async function runPool(rows, size, worker) {
  const queue = rows.slice();
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (row) await worker(row);
    }
  });
  await Promise.all(workers);
}

function nameTokens(name) {
  const stop = new Set([
    "the", "and", "store", "shop", "general", "limited", "ltd", "centre", "center", "cold",
    "drink", "drinks", "juice", "beverage", "beverages", "company", "mart", "point", "house",
    "pakistan", "foods", "food", "corner", "cafe", "restaurant",
  ]);
  return String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stop.has(token));
}

function mentions(url, tokens) {
  const blob = decodeURIComponent(url).toLowerCase();
  return tokens.some((token) => blob.includes(token));
}

function isListingHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return ["justdial.com", "yelp.com", "yellowpages.com", "tripadvisor.com", "sulekha.com", "indiamart.com"].some(
      (item) => host === item || host.endsWith("." + item)
    );
  } catch {
    return false;
  }
}

function isUselessProfile(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path === "/" || path === "") return true;
    return /\/(login|sharer|share|intent|dialog|home|explore|privacy|policies|settings|directory|legal)\b/.test(path);
  } catch {
    return true;
  }
}

function pushSocial(list, platform, url) {
  const clean = stripHash(url);
  if (!clean || !platform || list.some((item) => item.url === clean)) return;
  list.push({ platform, url: clean });
}

function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "fbclid", "igshid"].forEach((key) => parsed.searchParams.delete(key));
    return parsed.href;
  } catch {
    return "";
  }
}

function mergePhones(row, values) {
  row.phones = uniquePhones([...(row.phones || []), ...values.map(tidyPhone)]);
  row.phone = row.phones[0] || "";
}

function tidyPhone(value) {
  let phone = String(value || "").trim();
  if (!phone) return "";
  if (phone.startsWith("00")) phone = "+" + phone.slice(2).trim();
  phone = phone.replace(/[^\d+().\-\s]/g, "").replace(/\s+/g, " ").trim();
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return "";
  return phone;
}

function uniquePhones(list) {
  const seen = new Set();
  const out = [];
  for (const phone of list) {
    if (!phone) continue;
    const digits = phone.replace(/\D/g, "");
    const key = digits.length >= 10 ? digits.slice(-10) : digits;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phone);
  }
  return out;
}

function uniqueText(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function labelCategory(tags) {
  const raw = tags.shop || tags.amenity || tags.craft || tags.tourism || tags.office || tags.leisure || "";
  if (!raw || raw === "yes") return "";
  return String(raw).replaceAll("_", " ");
}

function tidyAddress(parts) {
  const out = [];
  for (const part of parts) {
    const bit = String(part || "").replace(/\s+/g, " ").trim().replace(/^,+|,+$/g, "");
    if (!bit) continue;
    if (out.some((item) => item.toLowerCase() === bit.toLowerCase())) continue;
    out.push(bit);
  }
  return out.join(", ");
}

function cleanSite(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function matches(keyword, key) {
  if (key.length < 5) return keyword === key;
  return keyword === key || keyword.includes(key);
}

function detailScore(row) {
  return (row.phone ? 2 : 0) + (row.email ? 2 : 0) + (row.website ? 2 : 0) + (row.social?.length ? 2 : 0) + (row.address ? 1 : 0);
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.name.toLowerCase()}|${row.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function unique(list) {
  return [...new Set(list.map((item) => item.toLowerCase()))];
}

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanKeyword(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
