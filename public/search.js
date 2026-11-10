const MAX_RESULTS = 80;

const CATEGORIES = [
  { keys: ["beverage", "beverages", "drink", "drinks", "juice", "soda", "soft drink", "cold drink"], names: ["beverage", "juice", "drink", "soda", "cola", "squash"], tags: [["shop", "beverages"], ["shop", "alcohol"], ["shop", "wine"], ["shop", "tea"], ["craft", "brewery"]] },
  { keys: ["restaurant", "restaurants", "food", "dhaba"], names: ["restaurant"], tags: [["amenity", "restaurant"], ["amenity", "fast_food"]] },
  { keys: ["cafe", "coffee"], names: ["cafe", "coffee"], tags: [["amenity", "cafe"], ["shop", "coffee"]] },
  { keys: ["pharmacy", "pharmacies", "medical store", "chemist", "drugstore"], names: ["pharmacy", "chemist"], tags: [["amenity", "pharmacy"]] },
  { keys: ["hospital", "hospitals", "clinic", "clinics"], names: ["hospital", "clinic"], tags: [["amenity", "hospital"], ["amenity", "clinic"], ["amenity", "doctors"]] },
  { keys: ["hotel", "hotels", "guest house"], names: ["hotel"], tags: [["tourism", "hotel"], ["tourism", "guest_house"]] },
  { keys: ["gym", "fitness"], names: ["gym", "fitness"], tags: [["leisure", "fitness_centre"], ["leisure", "sports_centre"]] },
  { keys: ["school", "schools"], names: ["school"], tags: [["amenity", "school"]] },
  { keys: ["bank", "banks"], names: ["bank"], tags: [["amenity", "bank"]] },
  { keys: ["supermarket", "grocery", "mart", "kiryana"], names: ["supermarket", "grocery", "mart"], tags: [["shop", "supermarket"], ["shop", "convenience"], ["shop", "general"]] },
  { keys: ["bakery", "bakeries"], names: ["bakery"], tags: [["shop", "bakery"]] },
  { keys: ["clothing", "clothes", "garment", "fashion"], names: ["garment", "cloth"], tags: [["shop", "clothes"]] },
  { keys: ["electronics", "mobile", "phone shop"], names: ["electronic", "mobile"], tags: [["shop", "electronics"], ["shop", "mobile_phone"]] },
  { keys: ["salon", "saloon", "barber", "beauty"], names: ["salon", "barber"], tags: [["shop", "beauty"], ["shop", "hairdresser"]] },
  { keys: ["petrol", "fuel", "gas station"], names: ["petrol", "fuel"], tags: [["amenity", "fuel"]] },
];

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

async function searchPlaces({ country, city, keyword }, options = {}) {
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
  businesses.sort((a, b) => detailScore(b) - detailScore(a) || a.name.localeCompare(b.name));
  const notes = businesses.length
    ? ["Yeh woh businesses hain jin ki detail public maps par likhi hai: naam, address, number, email, website, aur social links. Jo online listed nahi, woh yahan nahi aata."]
    : ["Is city ke public listings mein yeh business type nahi mila. Spelling ya koi aur city try karo."];
  return { kind: "directory", country: countryName, city: placeName, keyword: term, area: place.display, count: businesses.length, businesses, notes };
}

async function geocode(city, country, signal) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", `${city}, ${country}`);
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("City lookup fail ho gayi. Dobara try karo.");
  const payload = await response.json();
  const feature = payload.features?.[0];
  const [lon, lat] = feature?.geometry?.coordinates || [];
  if (!feature || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Yeh city is country mein nahi mili.");
  const extent = feature.properties?.extent;
  const span = Array.isArray(extent) && extent.length === 4
    ? Math.max(Math.abs(extent[1] - extent[3]), Math.abs(extent[2] - extent[0]))
    : 0.2;
  const radius = Math.round(Math.min(Math.max(span * 111000 * 0.55, 6000), 20000));
  const props = feature.properties || {};
  return {
    lat,
    lon,
    radius,
    city,
    display: [props.name, props.state, props.country].filter(Boolean).join(", ") || `${city}, ${country}`,
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
    response = await fetch(url, { signal, headers: { accept: "application/json" } });
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
      headers: { "content-type": "application/x-www-form-urlencoded" },
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
  if (!businessLike || tags.highway || tags.natural || tags.landuse || tags.waterway) return { name: "" };
  const lat = element.lat || element.center?.lat;
  const lon = element.lon || element.center?.lon;
  const phones = uniquePhones(phoneList(tags));
  const social = socialFromTags(tags, phones);
  let website = cleanSite(tags.website || tags["contact:website"] || tags.url || "");
  const sitePlatform = website && socialPlatform(website);
  if (sitePlatform) {
    pushSocial(social, sitePlatform, website);
    website = "";
  }
  const numbers = uniquePhones(phones);
  return {
    name: tags.name || tags["name:en"] || tags.brand || "",
    category: labelCategory(tags),
    address: tidyAddress([tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"], tags["addr:city"] || city, tags["addr:postcode"]]),
    phone: numbers[0] || "",
    phones: numbers,
    email: tags.email || tags["contact:email"] || "",
    emails: uniqueText([tags.email, tags["contact:email"]]),
    website,
    social,
    hours: tags.opening_hours || "",
    maps: Number.isFinite(lat) && Number.isFinite(lon) ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` : "",
  };
}

function phoneList(tags) {
  const out = [];
  for (const item of [tags.phone, tags["contact:phone"], tags.mobile, tags["contact:mobile"], tags["phone:mobile"]]) {
    for (const part of String(item || "").split(/[;,]|\s+or\s+/i)) {
      const phone = tidyPhone(part);
      if (phone) out.push(phone);
    }
  }
  return out;
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

function socialPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "instagram.com") return "Instagram";
    if (host === "facebook.com" || host === "fb.com") return "Facebook";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
    if (host === "twitter.com" || host === "x.com") return "X";
    if (host === "youtube.com" || host === "youtu.be") return "YouTube";
    if (host === "tiktok.com") return "TikTok";
    if (host === "wa.me" || host === "whatsapp.com") return "WhatsApp";
    if (host === "t.me" || host === "telegram.me") return "Telegram";
  } catch {
    return "";
  }
  return "";
}

function asSocialUrl(base, raw) {
  const value = String(raw || "").trim();
  if (!value || /^yes$/i.test(value)) return "";
  if (/^https?:\/\//i.test(value)) return cleanSite(value);
  const handle = value.replace(/^@/, "").split(/[/?#\s]/)[0];
  if (!/^[\w.\-]{2,80}$/.test(handle)) return "";
  return base + handle;
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
    return parsed.href;
  } catch {
    return "";
  }
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
    if (!bit || out.some((item) => item.toLowerCase() === bit.toLowerCase())) continue;
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
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}
