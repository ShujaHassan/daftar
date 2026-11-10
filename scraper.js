import dns from "node:dns/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const MAX_PAGES = 8;
const MAX_SOCIAL = 8;
const MAX_BYTES = 1_200_000;

const PLATFORMS = [
  [/^(?:www\.)?instagram\.com$/i, "Instagram"],
  [/^(?:www\.)?(?:facebook|fb)\.com$/i, "Facebook"],
  [/^(?:[\w-]+\.)?linkedin\.com$/i, "LinkedIn"],
  [/^(?:www\.)?(?:twitter\.com|x\.com)$/i, "X"],
  [/^(?:www\.)?(?:youtube\.com|youtu\.be)$/i, "YouTube"],
  [/^(?:www\.)?tiktok\.com$/i, "TikTok"],
  [/^(?:www\.)?pinterest\.(?:com|co\.uk)$/i, "Pinterest"],
  [/^(?:www\.)?(?:wa\.me|whatsapp\.com|api\.whatsapp\.com)$/i, "WhatsApp"],
  [/^(?:www\.)?(?:t\.me|telegram\.me)$/i, "Telegram"],
  [/^(?:www\.)?threads\.net$/i, "Threads"],
  [/^(?:www\.)?snapchat\.com$/i, "Snapchat"],
  [/^(?:www\.)?github\.com$/i, "GitHub"],
  [/^(?:www\.)?(?:open\.)?spotify\.com$/i, "Spotify"],
  [/^(?:www\.)?bsky\.app$/i, "Bluesky"],
];

const DIRECTORY_HOSTS = [
  "wikipedia.org",
  "wikidata.org",
  "yelp.com",
  "yellowpages.com",
  "crunchbase.com",
  "bloomberg.com",
  "zoominfo.com",
  "google.com",
  "bing.com",
  "amazon.com",
  "duckduckgo.com",
];

const EMAIL_BLOCK_HOSTS = [
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "email.com",
  "test.com",
  "mysite.com",
  "yourdomain.com",
  "sentry.io",
  "wixpress.com",
  "schema.org",
  "w3.org",
  "godaddy.com",
  "squarespace.com",
  "placeholder.com",
  "email-protection.com",
];

const CONTACT_PATHS = ["/contact", "/contact-us", "/contactus", "/about", "/about-us", "/aboutus"];

export function platformOf(url) {
  return socialKind(url);
}

export function socialKind(url) {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    return "";
  }
  for (const [re, name] of PLATFORMS) {
    if (re.test(host)) return name;
  }
  if (/^\/@[a-z0-9_.]+\/?$/.test(path) && /social|mastodon/.test(host)) return "Mastodon";
  return "";
}

function pathShortcut(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return false;
    if (!/^(twitter|facebook|instagram|youtube|linkedin|tiktok|mastodon|threads|pinterest)$/i.test(parts[0])) return false;
    return !isSocialUrl(parsed.origin + "/");
  } catch {
    return false;
  }
}

function isSocialUrl(url) {
  return Boolean(socialKind(url));
}

export function parseInput(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    const error = new Error("Website, business ka naam, ya link likho.");
    error.statusCode = 400;
    throw error;
  }
  if (text.length > 4000) {
    const error = new Error("Itna lamba text nahi. URL ya naam kaafi hai.");
    error.statusCode = 400;
    throw error;
  }
  const lines = text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = [];
  for (const line of lines) {
    const asUrl = toHttpUrl(line);
    if (asUrl) urls.push(asUrl);
  }
  if (urls.length === lines.length && urls.length > 0) {
    return { mode: "urls", urls: unique(urls) };
  }
  if (lines.length === 1) {
    const email = lines[0].toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
      return { mode: "urls", urls: ["https://" + email.split("@")[1]], seedEmail: email };
    }
    const asUrl = toHttpUrl(lines[0]);
    if (asUrl) return { mode: "urls", urls: [asUrl] };
    return { mode: "name", name: lines[0] };
  }
  if (urls.length) return { mode: "urls", urls: unique(urls) };
  return { mode: "name", name: text.replace(/\s+/g, " ") };
}

function toHttpUrl(value) {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[\/:?#][^\s]*)?$/i.test(v)) return "https://" + v;
  return "";
}

export async function buildDossier(rawInput, options = {}) {
  const flags = {
    email: options.email !== false,
    phone: options.phone !== false,
    website: options.website !== false,
    social: options.social !== false,
  };
  if (!flags.email && !flags.phone && !flags.website && !flags.social) {
    throw new Error("Kam az kam ek cheez select karo: email, phone, website, ya social.");
  }
  const signal = options.signal;
  const emit = options.onEvent || (() => {});
  const cache = new Map();
  const parsed = parseInput(rawInput);

  let targets = [];
  let socialSeeds = [];
  let queryName = "";

  if (parsed.mode === "name") {
    queryName = parsed.name;
    emit({ message: `“${parsed.name}” ki public website dhoondh raha hoon…` });
    const found = await searchWeb(parsed.name, signal, cache);
    if (!found.length) {
      throw new Error("Website nahi mili. Business ka seedha URL paste karo.");
    }
    const primary = found.find((u) => !isSocialUrl(u) && !isDirectory(u)) || found[0];
    targets = [primary];
    socialSeeds = found.filter((u) => isSocialUrl(u) && !isUselessSocial(u));
    emit({ message: `Website mili: ${primary}` });
  } else {
    const webs = parsed.urls.filter((u) => !isSocialUrl(u));
    const socials = parsed.urls.filter((u) => isSocialUrl(u));
    targets = webs.length ? webs.slice(0, 3) : parsed.urls.slice(0, 3);
    socialSeeds = socials;
  }

  const wantCrawl = flags.email || flags.phone || flags.website;
  const pageBag = [];
  const extracts = [];

  for (const target of targets) {
    throwIfAborted(signal);
    if (pageBag.length >= MAX_PAGES) break;
    if (wantCrawl && !isSocialUrl(target)) {
      await crawlSite(target, { signal, cache, emit, pageBag, extracts });
    } else {
      await readOne(target, { signal, cache, emit, pageBag, extracts, kind: "page" });
    }
  }

  if (wantCrawl && targets.every((u) => isSocialUrl(u))) {
    const hint = firstExternalWebsite(extracts);
    if (hint && pageBag.length < MAX_PAGES) {
      emit({ message: `Social page se website mili: ${hint}` });
      await crawlSite(hint, { signal, cache, emit, pageBag, extracts, limit: 4 });
    }
  }

  if (!pageBag.some((p) => p.ok)) {
    const firstErr = pageBag.find((p) => p.error);
    throw new Error(firstErr?.error || "Page nahi khul saki. URL check karo.");
  }

  let social = [];
  if (flags.social) {
    const discovered = [];
    const shortcuts = [];
    for (const ex of extracts) discovered.push(...ex.socials.map((s) => s.url));
    discovered.push(...socialSeeds);
    for (const ex of extracts) {
      for (const link of ex.links) {
        if (isSocialUrl(link.href) && !isUselessSocial(link.href)) discovered.push(link.href);
        else if (pathShortcut(link.href)) shortcuts.push(link.href);
      }
    }
    const ranked = unique(discovered.filter((u) => isSocialUrl(u) && !isUselessSocial(u)))
      .sort((a, b) => socialRank(b) - socialRank(a))
      .slice(0, MAX_SOCIAL);
    const jobs = [
      ...ranked.map((url) => ({ url, confirmRedirect: false })),
      ...unique(shortcuts).slice(0, 4).map((url) => ({ url, confirmRedirect: true })),
    ];
    for (const job of jobs) {
      const url = job.url;
      throwIfAborted(signal);
      const platform = socialKind(url) || "Social";
      const existing = pageBag.find((page) => canonKey(page.finalUrl || page.url) === canonKey(url));
      if (existing?.extract && !job.confirmRedirect) {
        social.push({
          platform,
          url: existing.finalUrl || url,
          title: cleanText(existing.extract.title || existing.extract.siteName || "", 140),
          description: cleanText(existing.extract.description || "", 280),
          status: socialStatus(existing, existing.extract),
        });
        continue;
      }
      emit({ message: `${platform === "Social" ? "Social link" : platform} ka public page dekh raha hoon…` });
      const page = await readOne(url, {
        signal,
        cache,
        emit,
        pageBag: [],
        extracts: [],
        kind: "social",
        quiet: true,
      });
      const landed = socialKind(page.finalUrl || url);
      if (job.confirmRedirect && !landed) continue;
      const ex = page.extract;
      social.push({
        platform: landed || platform,
        url: page.finalUrl || url,
        title: cleanText(ex?.title || ex?.siteName || "", 140),
        description: cleanText(ex?.description || "", 280),
        status: socialStatus(page, ex),
      });
      if (ex && landed) {
        ex.pageUrl = page.finalUrl || url;
        extracts.push(ex);
      }
    }
  }

  emit({ message: "Final list bana raha hoon…" });
  return composeDossier({
    flags,
    queryName,
    parsed,
    targets,
    pageBag,
    extracts,
    social,
  });
}

async function crawlSite(startUrl, ctx) {
  const limit = ctx.limit || MAX_PAGES;
  const queue = [{ url: startUrl, score: 100 }];
  const seen = new Set();
  let probedContacts = false;
  let siteHost = "";
  let attempts = 0;
  const maxAttempts = limit + CONTACT_PATHS.length;

  while (queue.length && ctx.pageBag.filter((page) => page.ok).length < limit && attempts < maxAttempts) {
    attempts += 1;
    queue.sort((a, b) => b.score - a.score);
    const next = queue.shift();
    const key = canonKey(next.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const page = await readOne(next.url, { ...ctx, kind: "page", optional: next.optional });
    const finalKey = canonKey(page.finalUrl || next.url);
    if (finalKey) seen.add(finalKey);
    if (!page.extract) continue;
    if (!siteHost) {
      try {
        siteHost = hostKey(new URL(page.finalUrl).hostname);
      } catch {
        siteHost = "";
      }
    }
    if (!probedContacts && siteHost) {
      probedContacts = true;
      let origin = "";
      try {
        origin = new URL(page.finalUrl).origin;
      } catch {
        origin = "";
      }
      if (origin) {
        const home = origin + "/";
        if (canonKey(home) !== canonKey(page.finalUrl || startUrl)) {
          queue.push({ url: home, score: 6 });
        }
        const haveContact = ctx.pageBag.some((item) => item.ok && /\/contact(?:-us|us)?\/?$/i.test(pathOf(item.finalUrl)));
        const haveAbout = ctx.pageBag.some((item) => item.ok && /\/about(?:-us|us)?\/?$/i.test(pathOf(item.finalUrl)));
        const paths = [];
        if (!haveContact) paths.push("/contact");
        if (!haveAbout) paths.push("/about");
        for (const path of paths) queue.push({ url: origin + path, score: 9, optional: true });
      }
    }
    for (const link of page.extract.links) {
      let host = "";
      try {
        host = hostKey(new URL(link.href).hostname);
      } catch {
        continue;
      }
      if (!siteHost || host !== siteHost) continue;
      const score = linkScore(link.href, link.text);
      if (score <= 0) continue;
      const linkKey = canonKey(link.href);
      if (!linkKey || seen.has(linkKey)) continue;
      if (queue.some((q) => canonKey(q.url) === linkKey)) continue;
      queue.push({ url: link.href, score });
    }
  }
}

async function readOne(url, ctx) {
  const entry = {
    url,
    finalUrl: url,
    status: 0,
    title: "",
    ok: false,
    error: "",
    extract: null,
  };
  try {
    throwIfAborted(ctx.signal);
    if (!ctx.quiet) ctx.emit({ message: `Page parh raha hoon: ${url}` });
    const fetched = await fetchText(url, ctx.signal, ctx.cache, ctx.optional ? 8000 : 15000);
    entry.finalUrl = fetched.url;
    entry.status = fetched.status;
    entry.ok = fetched.status >= 200 && fetched.status < 400 && !fetched.skipped;
    if (fetched.skipped) {
      entry.error = "Yeh HTML page nahi hai.";
      entry.ok = false;
    } else if (!entry.ok) {
      entry.error = `Page ${fetched.status} diya.`;
    }
    if (fetched.html) {
      entry.extract = extractFromHtml(fetched.html, fetched.url);
      entry.title = entry.extract.title || "";
      if (entry.ok || entry.extract.emails.length || entry.extract.phones.length) {
        ctx.extracts.push({ ...entry.extract, pageUrl: fetched.url });
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    entry.error = error?.message || "Page nahi khul saki.";
  }
  const finalKey = canonKey(entry.finalUrl || entry.url);
  const duplicate = finalKey && ctx.pageBag.some((page) => canonKey(page.finalUrl || page.url) === finalKey);
  if (!ctx.quiet && entry.status !== 404 && !duplicate && !(ctx.optional && !entry.ok)) ctx.pageBag.push(entry);
  return entry;
}

function firstExternalWebsite(extracts) {
  for (const ex of extracts) {
    let pageHost = "";
    try {
      pageHost = hostKey(new URL(ex.pageUrl).hostname);
    } catch {
      continue;
    }
    for (const link of ex.links) {
      try {
        const u = new URL(link.href);
        const host = hostKey(u.hostname);
        if (host === pageHost) continue;
        if (isSocialUrl(link.href) || isDirectory(link.href) || isJunkHost(host)) continue;
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        if (/\.(pdf|jpg|jpeg|png|gif|webp|zip)$/i.test(u.pathname)) continue;
        return u.origin;
      } catch {
        /* skip */
      }
    }
  }
  return "";
}

function composeDossier({ flags, queryName, parsed, targets, pageBag, extracts, social }) {
  const emails = new Map();
  const phones = new Map();
  const addresses = new Map();
  const hours = new Set();
  const names = [];
  const descriptions = [];
  const logos = [];
  const types = new Set();
  let spa = false;

  if (parsed.seedEmail) addEmail(emails, parsed.seedEmail, targets[0] || "", "high");

  for (const ex of extracts) {
    const source = ex.pageUrl || "";
    if (ex.spaHint) spa = true;
    for (const item of ex.emails) addEmail(emails, item.value, source, item.confidence);
    for (const item of ex.phones) addPhone(phones, item.value, source, item.confidence);
    for (const address of ex.addresses) {
      const clean = cleanText(address, 240);
      if (clean.length > 8) addresses.set(clean.toLowerCase(), clean);
    }
    for (const hour of ex.hours) {
      const clean = cleanText(hour, 160);
      if (clean) hours.add(clean);
    }
    names.push(...ex.names);
    descriptions.push(...ex.descriptions);
    if (ex.logo) logos.push(ex.logo);
    for (const t of ex.types) types.add(t);
    if (ex.siteName) names.push({ name: ex.siteName, score: 4 });
    const fromTitle = nameFromTitle(ex.title);
    if (fromTitle) names.push({ name: fromTitle, score: 2 });
    if (ex.description) descriptions.push({ text: ex.description, score: 2 });
    if (ex.textLead) descriptions.push({ text: ex.textLead, score: 1 });
  }

  for (const s of social) {
    const fromWa = phoneFromWhatsapp(s.url);
    if (fromWa) addPhone(phones, fromWa, s.url, "high");
  }

  const website = pickWebsite(pageBag, targets);
  const name =
    pickRanked(names, (n) => n.score, (n) => n.name) ||
    queryName ||
    hostLabel(website);

  const description = pickRanked(descriptions, (n) => n.score, (n) => n.text);
  const logo = logos.map((u) => absUrl(u, website)).find(Boolean) || "";

  const emailList = flags.email ? topValues(emails, 40) : [];
  const phoneList = flags.phone ? topValues(phones, 25) : [];
  const notes = [];
  if (spa) {
    notes.push("Kuch hissa script se load hota hai. Jo seedha HTML mein tha, wahi nikla.");
  }
  const limited = social.filter((s) => s.status !== "public").length;
  if (flags.social && limited) {
    notes.push("Kuch social pages ne poori public detail nahi di. Link phir bhi final list mein hai.");
  }
  if (!emailList.length && flags.email) notes.push("Public HTML mein email nahi mili.");
  if (!phoneList.length && flags.phone) notes.push("Public HTML mein phone nahi mila.");

  return {
    fetchedAt: new Date().toISOString(),
    query: queryName || targets[0] || "",
    flags,
    business: {
      name: flags.website || name ? name : name,
      website: website || "",
      description: flags.website ? description : "",
      address: flags.website ? [...addresses.values()][0] || "" : "",
      addresses: flags.website ? [...addresses.values()].slice(0, 4) : [],
      logo: flags.website ? logo : "",
      category: flags.website ? [...types].slice(0, 3).join(", ") : "",
      hours: flags.website ? [...hours].slice(0, 6) : [],
    },
    emails: emailList,
    phones: phoneList,
    social: flags.social ? dedupeSocial(social) : [],
    pages: pageBag.map((p) => ({
      url: p.finalUrl || p.url,
      status: p.status || 0,
      title: cleanText(p.title, 140),
      ok: p.ok,
      error: p.error || "",
    })),
    notes,
  };
}

function pickWebsite(pageBag, targets) {
  const ok = pageBag.find((p) => p.ok && !isSocialUrl(p.finalUrl || p.url));
  if (ok) {
    try {
      return new URL(ok.finalUrl || ok.url).origin;
    } catch {
      /* fall through */
    }
  }
  const web = targets.find((u) => !isSocialUrl(u));
  if (!web) return "";
  try {
    return new URL(web).origin;
  } catch {
    return web;
  }
}

function pickRanked(items, scoreOf, valueOf) {
  const sorted = items
    .filter((item) => usableText(valueOf(item)))
    .sort((a, b) => scoreOf(b) - scoreOf(a) || valueOf(b).length - valueOf(a).length);
  return sorted.length ? cleanText(valueOf(sorted[0]), 500) : "";
}

function nameFromTitle(title) {
  const clean = cleanText(title, 180);
  if (!clean) return "";
  const parts = clean.split(/\s+[|\-–—:]\s+/).map((part) => part.trim()).filter((part) => usableText(part));
  if (!parts.length) return "";
  const generic = /contact|about|home|blog|shop|menu|faq|privacy|terms/i;
  const specific = parts.filter((part) => !generic.test(part));
  const pool = (specific.length ? specific : parts).slice().sort((a, b) => a.length - b.length);
  return pool[0];
}

function usableText(value) {
  const t = String(value || "").trim();
  if (t.length < 2 || t.length > 500) return false;
  if (/^(home|contact us|contact|about|about us|welcome|untitled)$/i.test(t)) return false;
  return true;
}

function addEmail(map, value, source, confidence) {
  const email = cleanEmail(value);
  if (!email) return;
  const prev = map.get(email);
  if (!prev) {
    map.set(email, { value: email, sources: source ? [source] : [], confidence });
    return;
  }
  if (source && !prev.sources.includes(source)) prev.sources.push(source);
  if (confidence === "high") prev.confidence = "high";
}

function addPhone(map, value, source, confidence) {
  const display = cleanPhone(value);
  const digits = display.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return;
  if (/^(\d)\1+$/.test(digits)) return;
  const key = digits.length >= 10 ? digits.slice(-10) : digits;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, { value: display, sources: source ? [source] : [], confidence, digits });
    return;
  }
  if (source && !prev.sources.includes(source)) prev.sources.push(source);
  if (confidence === "high") prev.confidence = "high";
  if (betterPhone(display, prev.value)) prev.value = display;
}

function betterPhone(next, prev) {
  const nextPlus = next.trim().startsWith("+") ? 1 : 0;
  const prevPlus = prev.trim().startsWith("+") ? 1 : 0;
  if (nextPlus !== prevPlus) return nextPlus > prevPlus;
  return next.replace(/\D/g, "").length > prev.replace(/\D/g, "").length;
}

function topValues(map, max) {
  return [...map.values()]
    .sort((a, b) => {
      const c = (b.confidence === "high") - (a.confidence === "high");
      return c || b.sources.length - a.sources.length;
    })
    .slice(0, max)
    .map(({ value, sources, confidence }) => ({ value, sources, confidence }));
}

function dedupeSocial(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = canonKey(item.url) || item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function extractFromHtml(html, pageUrl) {
  const raw = String(html || "");
  const metas = readMetas(raw);
  const title = readTitle(raw);
  const ld = readJsonLd(raw);
  const bag = {
    emails: [],
    phones: [],
    addresses: [],
    hours: [],
    names: [],
    descriptions: [],
    logos: [],
    types: [],
    sameAs: [],
  };
  for (const node of ld) collectLd(node, bag);

  for (const href of matchAll(raw, /href\s*=\s*(?:"mailto:([^"]+)"|'mailto:([^']+)'|mailto:([^\s>"']+))/gi)) {
    bag.emails.push(href);
  }
  for (const href of matchAll(raw, /href\s*=\s*(?:"tel:([^"]+)"|'tel:([^']+)'|tel:([^\s>"']+))/gi)) {
    bag.phones.push(href);
  }
  for (const hex of matchAll(raw, /data-cfemail\s*=\s*["']([0-9a-fA-F]+)["']/gi)) {
    const decoded = decodeCfEmail(hex);
    if (decoded) bag.emails.push(decoded);
  }
  for (const hex of matchAll(raw, /email-protection#([0-9a-fA-F]+)/gi)) {
    const decoded = decodeCfEmail(hex);
    if (decoded) bag.emails.push(decoded);
  }

  const links = readAnchors(raw, pageUrl);
  const socials = [];
  for (const link of links) {
    const kind = socialKind(link.href);
    if (kind && !isUselessSocial(link.href)) {
      socials.push({ platform: kind, url: stripTrackers(link.href) });
    }
  }
  for (const same of bag.sameAs) {
    const abs = absUrl(same, pageUrl);
    const kind = abs && socialKind(abs);
    if (kind && !isUselessSocial(abs)) {
      socials.push({ platform: kind, url: stripTrackers(abs) });
    }
  }
  for (const link of links) {
    const wa = phoneFromWhatsapp(link.href);
    if (wa) bag.phones.push(wa);
  }

  const withoutCode = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const addressBlocks = matchAll(withoutCode, /<address\b[^>]*>([\s\S]*?)<\/address>/gi);
  for (const block of addressBlocks) {
    const text = cleanText(block.replace(/<[^>]+>/g, " "), 240);
    if (text) bag.addresses.push(text);
  }
  const text = decodeEntities(deobfuscate(withoutCode.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))).slice(0, 200_000);
  for (const email of text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []) {
    bag.emails.push(email);
  }
  collectPhonesFromText(text, bag.phones);

  const siteName = metas["og:site_name"] || metas["application-name"] || "";
  const description =
    pickRanked(
      bag.descriptions,
      (n) => n.score,
      (n) => n.text
    ) ||
    metas["description"] ||
    metas["og:description"] ||
    "";
  const logo = bag.logos.map((u) => absUrl(u, pageUrl)).find(Boolean) || absUrl(metas["og:image"] || "", pageUrl);

  const highEmails = new Set(
    bag.emails
      .slice(0, matchMailtoCount(raw) + ldEmailCount(bag))
      .map((e) => cleanEmail(e))
      .filter(Boolean)
  );
  const emails = [];
  const seenEmails = new Set();
  for (const value of bag.emails) {
    const email = cleanEmail(value);
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);
    emails.push({ value: email, confidence: highEmails.has(email) ? "high" : "medium" });
  }
  // mailto/json-ld/cf are extracted first, so mark those high by source order:
  markLeadingHigh(emails, raw, "email");

  const phones = [];
  const seenPhones = new Set();
  const telCount = (raw.match(/href\s*=\s*["']?tel:/gi) || []).length;
  const structuredPhones = bag.structuredPhones || 0;
  bag.phones.forEach((value, index) => {
    const display = cleanPhone(value);
    const digits = display.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return;
    const key = digits.length >= 10 ? digits.slice(-10) : digits;
    if (seenPhones.has(key)) return;
    seenPhones.add(key);
    const fromStructured = index < telCount + structuredPhones || display.startsWith("+");
    phones.push({ value: display, confidence: fromStructured ? "high" : "medium" });
  });

  const plainLen = text.trim().length;
  const scriptCount = (raw.match(/<script\b/gi) || []).length;
  return {
    title,
    siteName: cleanText(siteName, 120),
    description: cleanText(description, 500),
    logo,
    names: bag.names,
    descriptions: bag.descriptions,
    types: unique(bag.types),
    emails,
    phones,
    addresses: unique(bag.addresses.map((a) => cleanText(a, 240)).filter(Boolean)),
    hours: unique(bag.hours.map((h) => cleanText(h, 160)).filter(Boolean)),
    socials: dedupeSocial(socials.map((s) => ({ ...s, status: "found", title: "", description: "" }))),
    links,
    textLead: firstParagraph(withoutCode),
    spaHint: plainLen < 350 && scriptCount >= 6,
  };
}

function firstParagraph(html) {
  const match = String(html).match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return "";
  const text = cleanText(match[1].replace(/<[^>]+>/g, " "), 320);
  return text.length >= 40 ? text : "";
}

function markLeadingHigh(emails, raw, _kind) {
  const structured = new Set();
  for (const value of matchAll(raw, /href\s*=\s*(?:"mailto:([^"]+)"|'mailto:([^']+)'|mailto:([^\s>"']+))/gi)) {
    const email = cleanEmail(value);
    if (email) structured.add(email);
  }
  for (const hex of matchAll(raw, /data-cfemail\s*=\s*["']([0-9a-fA-F]+)["']/gi)) {
    const email = cleanEmail(decodeCfEmail(hex));
    if (email) structured.add(email);
  }
  for (const email of emails) {
    if (structured.has(email.value)) email.confidence = "high";
  }
}

function matchMailtoCount(raw) {
  return (raw.match(/mailto:/gi) || []).length;
}

function ldEmailCount(bag) {
  return bag.structuredEmails || 0;
}

function collectPhonesFromText(text, into) {
  const re = /(?:\+\d{1,3}[\s().-]*)?(?:\(?\d{2,4}\)?[\s().-]*){1,4}\d{2,4}/g;
  let match;
  while ((match = re.exec(text))) {
    const raw = match[0].trim();
    if (phoneFromTextOk(raw, text, match.index)) into.push(raw);
  }
}

function phoneFromTextOk(raw, text, index) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return false;
  const before = text.slice(Math.max(0, index - 24), index).toLowerCase();
  const hasPlus = raw.startsWith("+");
  const keyword = /(?:^|[^a-z])(phone|telephone|tel|call|mobile|whatsapp|contact|fax|cell|helpline|mob)(?:[^a-z]|$)|whats app/.test(before);
  if (hasPlus || keyword) return true;
  const groups = raw.split(/[\s().-]+/).filter(Boolean).map((group) => group.replace(/\D/g, ""));
  if (groups.length < 3 || groups.some((group) => group.length < 2 || group.length > 4)) return false;
  return digits.length >= 10;
}

function readAnchors(html, pageUrl) {
  const links = [];
  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = getAttr(match[1], "href");
    if (!href || href.startsWith("#") || /^javascript:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
      continue;
    }
    const abs = absUrl(href, pageUrl);
    if (!abs) continue;
    const text = cleanText(match[2].replace(/<[^>]+>/g, " "), 80);
    links.push({ href: abs, text });
  }
  const linkRe = /<link\b[^>]*>/gi;
  while ((match = linkRe.exec(html))) {
    const rel = getAttr(match[0], "rel").toLowerCase();
    if (!/\bme\b|\bcanonical\b/.test(rel)) continue;
    const href = getAttr(match[0], "href");
    const abs = absUrl(href, pageUrl);
    if (abs) links.push({ href: abs, text: rel });
  }
  return links;
}

function collectLd(node, bag, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLd(item, bag, depth + 1);
    return;
  }
  const types = typesOf(node);
  const score = typeScore(types);
  if (types.length) bag.types.push(...types.filter((t) => !/^(Thing|WebPage|ItemList|ListItem|SearchAction|ReadAction|ImageObject|PostalAddress|ContactPoint|OpeningHoursSpecification)$/i.test(t)));
  if (typeof node.name === "string" && score > 0) bag.names.push({ name: node.name, score });
  if (typeof node.description === "string" && node.description.trim()) {
    bag.descriptions.push({ text: node.description, score: Math.max(score, 1) });
  }
  if (typeof node.email === "string") {
    bag.emails.push(node.email);
    bag.structuredEmails = (bag.structuredEmails || 0) + 1;
  }
  if (Array.isArray(node.email)) {
    for (const email of node.email) {
      if (typeof email === "string") {
        bag.emails.push(email);
        bag.structuredEmails = (bag.structuredEmails || 0) + 1;
      }
    }
  }
  const beforePhones = bag.phones.length;
  pushPhoneValue(node.telephone, bag);
  bag.structuredPhones = (bag.structuredPhones || 0) + (bag.phones.length - beforePhones);
  if (node.address) {
    const formatted = formatAddress(node.address);
    if (formatted) bag.addresses.push(formatted);
  }
  if (node.sameAs) {
    const list = Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs];
    for (const item of list) if (typeof item === "string") bag.sameAs.push(item);
  }
  const logo = logoUrl(node.logo) || (score >= 3 ? logoUrl(node.image) : "");
  if (logo) bag.logos.push(logo);
  pushHours(node, bag);
  if (node["@graph"]) collectLd(node["@graph"], bag, depth + 1);
  if (node.mainEntity) collectLd(node.mainEntity, bag, depth + 1);
  if (node.contactPoint) collectLd(node.contactPoint, bag, depth + 1);
  if (node.department) collectLd(node.department, bag, depth + 1);
  if (node.location) collectLd(node.location, bag, depth + 1);
  if (node.publisher && score === 0) collectLd(node.publisher, bag, depth + 1);
}

function pushPhoneValue(value, bag) {
  if (!value) return;
  if (typeof value === "string" || typeof value === "number") bag.phones.push(String(value));
  else if (Array.isArray(value)) for (const item of value) pushPhoneValue(item, bag);
}

function pushHours(node, bag) {
  const hours = node.openingHours || node.openingHoursSpecification;
  if (!hours) return;
  const list = Array.isArray(hours) ? hours : [hours];
  for (const hour of list) {
    if (typeof hour === "string") bag.hours.push(hour);
    else if (hour && typeof hour === "object") {
      const day = []
        .concat(hour.dayOfWeek || [])
        .map((d) => String(d).split("/").pop())
        .join(", ");
      const time = [hour.opens, hour.closes].filter(Boolean).join("–");
      const line = [day, time].filter(Boolean).join(" ");
      if (line) bag.hours.push(line);
    }
  }
}

function formatAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return cleanText(addr, 240);
  if (Array.isArray(addr)) return formatAddress(addr[0]);
  const country = addr.addressCountry;
  const countryName =
    typeof country === "string" ? country : country?.name || country?.addressCountry || "";
  return [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode, countryName]
    .flat()
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim())
    .join(", ");
}

function logoUrl(logo) {
  if (!logo) return "";
  if (typeof logo === "string") return logo;
  if (Array.isArray(logo)) return logoUrl(logo[0]);
  if (typeof logo === "object") return logo.url || logo.contentUrl || logo["@id"] || "";
  return "";
}

function typesOf(node) {
  const t = node["@type"];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map((item) => String(item).split("/").pop());
}

function typeScore(types) {
  const blob = types.join(" ");
  if (/LocalBusiness|Store|Restaurant|Organization|Corporation|NGO|Hotel|Medical|ProfessionalService|Brand/i.test(blob)) {
    return 5;
  }
  if (/WebSite|OnlineBusiness|Place/i.test(blob)) return 3;
  if (/Person/i.test(blob)) return 1;
  return 0;
}

function readJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const text = match[1].replace(/<!--|-->/g, "").trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      /* invalid blocks are skipped */
    }
  }
  return out;
}

function readMetas(html) {
  const metas = {};
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const key = (getAttr(match[0], "property") || getAttr(match[0], "name") || getAttr(match[0], "itemprop")).toLowerCase();
    const content = getAttr(match[0], "content");
    if (key && content && !metas[key]) metas[key] = content;
  }
  return metas;
}

function readTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(decodeEntities(match[1]), 180) : "";
}

function getAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const match = String(tag).match(re);
  if (!match) return "";
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

export function cleanEmail(value) {
  let email = decodeEntities(String(value || ""))
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .trim()
    .toLowerCase();
  email = email.replace(/^<|>$/g, "");
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) return "";
  if (email.length > 80) return "";
  const [local, host] = email.split("@");
  if (!local || !host || local.startsWith(".") || local.endsWith(".")) return "";
  if (/\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$/i.test(host) || /\.(png|jpe?g|gif|webp|svg)$/i.test(email)) return "";
  if (EMAIL_BLOCK_HOSTS.some((blocked) => host === blocked || host.endsWith("." + blocked))) return "";
  if (/^(no-?reply|donotreply|sentry|webpack|example|test|user|username|name|email|yourname)$/i.test(local) && /example|test|domain|sentry|wix/.test(host)) {
    return "";
  }
  return email;
}

function cleanPhone(value) {
  let phone = decodeEntities(String(value || "")).replace(/^tel:/i, "").trim();
  phone = phone.replace(/[^\d+().\-\s]/g, "");
  phone = phone.replace(/\s+/g, " ").trim();
  if (phone.startsWith("00")) phone = "+" + phone.slice(2).trim();
  return phone;
}

function phoneFromWhatsapp(url) {
  const match = String(url).match(/wa\.me\/(\d{8,15})/i) || String(url).match(/[?&]phone=(\d{8,15})/i);
  return match ? "+" + match[1] : "";
}

export function decodeCfEmail(hex) {
  const value = String(hex || "");
  if (value.length < 4 || value.length % 2) return "";
  const key = parseInt(value.slice(0, 2), 16);
  if (Number.isNaN(key)) return "";
  let out = "";
  for (let i = 2; i < value.length; i += 2) {
    const code = parseInt(value.slice(i, i + 2), 16);
    if (Number.isNaN(code)) return "";
    out += String.fromCharCode(code ^ key);
  }
  return out;
}

function deobfuscate(text) {
  return text
    .replace(/\s*[\[({]\s*at\s*[\])}]/gi, "@")
    .replace(/\s*[\[({]\s*dot\s*[\])}]/gi, ".");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*64;/g, "@")
    .replace(/&#x0*40;/gi, "@")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)));
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 32 || (code >= 127 && code < 160) || code > 0x10ffff) return " ";
  return String.fromCharCode(code);
}

function cleanText(value, max) {
  const text = decodeEntities(String(value || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trim() + "…";
}

function linkScore(url, text) {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 0;
  }
  if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|css|js|mp4|mp3|woff2?)(\?|$)/i.test(path)) return 0;
  if (/privacy|terms|login|signin|sign-up|cart|account|wp-admin|wp-login|\/tag\/|\/category\/|\/author\//i.test(path)) return 0;
  const label = (text || "").trim().toLowerCase();
  const short = label.length > 0 && label.length < 28;
  if (/\/contact(?:-us|us|-info)?\/?$/.test(path) || (short && /\bcontact\b/.test(label))) return 10;
  if (/imprint|impressum|\/locations?\/?$/.test(path) || (short && /\b(address|directions)\b/.test(label))) return 8;
  if (/^\/[a-z]{2}\/about(?:-us|us)?\/?$/.test(path)) return 0;
  if (/\/about(?:-us|us)?\/?$/.test(path) || (short && /^about\b/.test(label))) return 7;
  if (/\/(team|support|faq)\/?$/.test(path)) return 4;
  return 0;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function socialRank(url) {
  try {
    const path = new URL(url).pathname;
    if (/\/(watch|reel|p|posts|photo|photos|status|videos|share)\b/i.test(path)) return 1;
    return 5;
  } catch {
    return 0;
  }
}

function isUselessSocial(url) {
  if (/sharer|sharearticle|\/intent\/|\/share\?|share\.php|\/dialog\//i.test(url)) return true;
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path === "/" || path === "") return true;
    if (/\/(login|sharer|share|intent|dialog|home|explore|privacy|policies|settings|directory|legal)\b/.test(path)) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isDirectory(url) {
  try {
    const host = hostKey(new URL(url).hostname);
    return DIRECTORY_HOSTS.some((item) => host === item || host.endsWith("." + item));
  } catch {
    return false;
  }
}

function isJunkHost(host) {
  const blocked = [
    "google.com",
    "gstatic.com",
    "googleapis.com",
    "googleusercontent.com",
    "facebook.net",
    "fbcdn.net",
    "cloudflare.com",
    "jsdelivr.net",
    "w3.org",
    "schema.org",
    "apple.com",
    "doubleclick.net",
    "googletagmanager.com",
  ];
  return blocked.some((item) => host === item || host.endsWith("." + item));
}

function socialStatus(page, extract) {
  if (!page || page.error) return "error";
  if (page.status >= 400 || page.status === 0) return "blocked";
  const title = extract?.title || "";
  const description = extract?.description || "";
  const blob = `${title} ${description}`.toLowerCase();
  if (!title && !description) return "limited";
  if (/log in|sign up|login|sign in/.test(blob) && description.length < 40) return "limited";
  return "public";
}

async function searchWeb(name, signal, cache) {
  return findPublicPages(`${name} official website`, signal, cache);
}

export async function findPublicPages(query, signal, cache = new Map(), timeoutMs = 15000) {
  const q = encodeURIComponent(query);
  const attempts = [
    `https://html.duckduckgo.com/html/?q=${q}`,
    `https://lite.duckduckgo.com/lite/?q=${q}`,
  ];
  const found = [];
  for (const url of attempts) {
    throwIfAborted(signal);
    try {
      const page = await fetchText(url, signal, cache, timeoutMs);
      found.push(...extractSearchLinks(page.html));
      if (found.length) break;
    } catch {
      /* try the next public search page */
    }
  }
  const uniqueLinks = unique(found).slice(0, 8);
  const safe = [];
  for (const link of uniqueLinks) {
    try {
      await assertSafeUrl(link, cache);
      safe.push(link);
    } catch {
      /* skip unsafe or dead hosts */
    }
  }
  return safe;
}

function extractSearchLinks(html) {
  const links = [];
  const re = /<a\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const tag = match[0];
    const cls = getAttr(tag, "class");
    const href = getAttr(tag, "href");
    if (!href) continue;
    const interesting =
      /result__a|result-link/.test(cls) ||
      /uddg=/.test(href) ||
      (!/duckduckgo\.com/i.test(href) && /^https?:\/\//i.test(href) && /result/i.test(cls));
    if (!interesting && !/uddg=/.test(href)) continue;
    const real = unwrapSearchUrl(href);
    if (!real) continue;
    if (/duckduckgo\.com|bing\.com\/ck/i.test(real)) continue;
    links.push(real);
  }
  return links;
}

function unwrapSearchUrl(href) {
  try {
    const abs = href.startsWith("//") ? "https:" + href : href;
    if (!/^https?:/i.test(abs)) return "";
    const u = new URL(abs);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    if (/duckduckgo\.com$/i.test(u.hostname)) return "";
    return u.href;
  } catch {
    return "";
  }
}

export async function fetchText(url, signal, cache = new Map(), timeoutMs = 15000) {
  let current = url;
  for (let hop = 0; hop <= 5; hop += 1) {
    throwIfAborted(signal);
    await assertSafeUrl(current, cache);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: combined,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9,ur;q=0.8",
        },
      });
    } catch (error) {
      if (signal?.aborted) {
        const aborted = new Error("Ruk gaya.");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw new Error(error?.name === "TimeoutError" ? "Page time out ho gayi." : "Page nahi khul saki.");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Redirect kharab hai.");
      current = new URL(location, current).href;
      continue;
    }
    const type = response.headers.get("content-type") || "";
    if (response.status < 400 && type && !/html|xml|text\/plain|json/i.test(type)) {
      await response.body?.cancel();
      return { url: current, status: response.status, html: "", contentType: type, skipped: true };
    }
    const html = await readBody(response, MAX_BYTES);
    return { url: current, status: response.status, html, contentType: type, skipped: false };
  }
  throw new Error("Bohot zyada redirects.");
}

async function readBody(response, max) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (size - max))));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function assertSafeUrl(url, cache = new Map()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL theek nahi hai.");
  }
  if (parsed.username || parsed.password) throw new Error("URL mein username ya password mat daalo.");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Sirf public http ya https pages.");
  }
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new Error("Sirf normal website ports (80/443).");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHost(host)) throw new Error("Local ya private address allowed nahi. Public website do.");
  if (isIp(host)) {
    if (isPrivateAddress(host)) throw new Error("Local ya private address allowed nahi. Public website do.");
    return parsed;
  }
  if (!host.includes(".")) throw new Error("Local ya private address allowed nahi. Public website do.");
  if (!cache.has(host)) {
    let records = [];
    try {
      records = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error(`“${host}” resolve nahi hui. URL check karo.`);
    }
    if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
      throw new Error("Yeh website private network par point karti hai.");
    }
    cache.set(host, true);
  }
  return parsed;
}

function isBlockedHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.endsWith(".internal") || host.endsWith(".localdomain")) return true;
  if (host === "metadata.google.internal") return true;
  return false;
}

function isIp(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

export function isPrivateAddress(ip) {
  const value = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return false;
  }
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function hostKey(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function hostLabel(website) {
  try {
    const host = hostKey(new URL(website).hostname);
    return host.split(".")[0].replace(/[-_]/g, " ");
  } catch {
    return "";
  }
}

function canonKey(url) {
  try {
    const u = new URL(stripTrackers(url));
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return hostKey(u.hostname) + path + u.search;
  } catch {
    return "";
  }
}

function stripTrackers(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || key === "fbclid" || key === "si" || key === "igshid") {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function absUrl(url, base) {
  if (!url) return "";
  try {
    const abs = new URL(url, base || undefined);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return "";
    return abs.href;
  } catch {
    return "";
  }
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function matchAll(text, re) {
  const out = [];
  let match;
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const copy = new RegExp(re.source, flags);
  while ((match = copy.exec(text))) {
    const group = match.slice(1).find((part) => part);
    if (group) out.push(decodeEntities(group));
  }
  return out;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Ruk gaya.");
    error.name = "AbortError";
    throw error;
  }
}
