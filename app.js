const form = document.querySelector("#form");
const directoryForm = document.querySelector("#directory");
const queryEl = document.querySelector("#query");
const countryEl = document.querySelector("#country");
const cityEl = document.querySelector("#city");
const cityCustomEl = document.querySelector("#city-custom");
const keywordEl = document.querySelector("#keyword");
const go = document.querySelector("#go");
const find = document.querySelector("#find");
const stop = document.querySelector("#stop");
const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const sheet = document.querySelector("#sheet");
const chips = document.querySelector("#chips");

let current = null;
fillPlaces();
renderHistory();

countryEl.addEventListener("change", () => fillCities(countryEl.value));
cityEl.addEventListener("change", () => {
  const custom = cityEl.value === "__other";
  cityCustomEl.hidden = !custom;
  cityCustomEl.required = custom;
});

directoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const city = cityEl.value === "__other" ? cityCustomEl.value.trim() : cityEl.value;
  if (!countryEl.value || !city || !keywordEl.value.trim()) {
    showError("Country, city, aur business type select karo.");
    return;
  }
  startDirectory(countryEl.value, city, keywordEl.value.trim());
});

chips.addEventListener("click", (event) => {
  const sample = event.target?.dataset?.sample;
  if (!sample) return;
  queryEl.value = sample;
  form.requestSubmit();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const flags = ["email", "phone", "website", "social"].filter((key) => data.get(key));
  if (!flags.length) {
    showError("Kam az kam ek cheez select karo: email, phone, website, ya social.");
    return;
  }
  startScrape(data.get("query"), flags);
});

stop.addEventListener("click", () => {
  current?.abort();
});

async function startDirectory(country, city, keyword) {
  await streamSearch("/api/directory", { country, city, keyword }, () => `${keyword} · ${city}`);
}

async function startScrape(query, flags) {
  await streamSearch("/api/scrape", {
    query,
    email: flags.includes("email"),
    phone: flags.includes("phone"),
    website: flags.includes("website"),
    social: flags.includes("social"),
  }, () => query);
}

async function streamSearch(url, body, historyName, onDone) {
  current?.abort();
  const controller = new AbortController();
  current = controller;
  sheet.hidden = true;
  sheet.replaceChildren();
  hide(errorEl);
  show(statusEl, "Shuru ho raha hai…");
  setBusy(true);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      showError("Server ne jawab nahi diya.");
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt >= 0) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const parsed = parseEvent(raw);
        if (parsed?.event === "status") show(statusEl, parsed.data.message || "");
        if (parsed?.event === "error") showError(parsed.data.message || "Scrape fail ho gaya.");
        if (parsed?.event === "done") {
          finished = true;
          hide(statusEl);
          if (parsed.data.kind === "directory") renderDirectory(parsed.data);
          else if (onDone) onDone(parsed.data);
          else renderSheet(parsed.data);
          remember(historyName(), parsed.data.business?.name || parsed.data.keyword || historyName(), parsed.data.kind === "directory" ? "directory" : "page");
        }
        splitAt = buffer.indexOf("\n\n");
      }
    }
    if (!finished && errorEl.hidden) showError("Jawab adhoora aa gaya. Dobara try karo.");
  } catch (error) {
    if (error?.name !== "AbortError") showError("Connection ruk gaya.");
    else show(statusEl, "Ruk gaya.");
  } finally {
    setBusy(false);
    if (current === controller) current = null;
  }
}

function setBusy(busy) {
  go.disabled = busy;
  find.disabled = busy;
  stop.hidden = !busy;
}

function fillPlaces() {
  countryEl.replaceChildren();
  for (const [country] of PLACES) {
    countryEl.append(new Option(country, country));
  }
  fillCities(countryEl.value);
}

function fillCities(country) {
  const match = PLACES.find((row) => row[0] === country);
  const cities = match ? match[1] : [];
  cityEl.replaceChildren();
  for (const city of cities) cityEl.append(new Option(city, city));
  cityEl.append(new Option("Koi aur city", "__other"));
  cityCustomEl.hidden = true;
  cityCustomEl.required = false;
  cityCustomEl.value = "";
}

function parseEvent(raw) {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function renderDirectory(result) {
  sheet.hidden = false;
  sheet.replaceChildren();
  const top = el("div", { class: "sheet-top" });
  const heading = el("div");
  heading.append(
    el("p", { class: "kicker", text: "FINAL DATA" }),
    el("h1", { text: `${result.keyword} · ${result.city}` }),
    el("p", { class: "address", text: result.area || `${result.city}, ${result.country}` })
  );
  top.append(heading, el("div", { class: "stamp", text: "LIST" }));
  sheet.append(top);

  const counts = el("div", { class: "summary" });
  counts.append(el("span", { text: `${result.count} businesses` }));
  const phones = result.businesses.filter((row) => row.phone || row.phones?.length).length;
  const emails = result.businesses.filter((row) => row.email || row.emails?.length).length;
  const socials = result.businesses.filter((row) => row.social?.length).length;
  const sites = result.businesses.filter((row) => row.website).length;
  counts.append(
    el("span", { text: `${phones} phones` }),
    el("span", { text: `${emails} emails` }),
    el("span", { text: `${socials} social` }),
    el("span", { text: `${sites} websites` })
  );
  sheet.append(counts);

  const list = el("div", { class: "biz-list" });
  if (!result.businesses.length) list.append(empty("Is search par koi public business nahi mila."));
  for (const row of result.businesses) list.append(businessCard(row));
  sheet.append(list);

  if (result.notes?.length) {
    const notes = el("div", { class: "notes" });
    for (const note of result.notes) notes.append(el("p", { class: "note", text: note }));
    sheet.append(notes);
  }
  const tools = el("div", { class: "tools" });
  tools.append(
    actionButton("Copy JSON", () => copyText(JSON.stringify(result, null, 2))),
    actionButton("Download CSV", () => downloadDirectoryCsv(result)),
    actionButton("Print", () => window.print())
  );
  sheet.append(tools);
  sheet.scrollIntoView({ behavior: "smooth", block: "start" });
}

function businessCard(row) {
  const card = el("article", { class: "biz-card" });
  card.append(el("h3", { text: row.name }));
  if (row.category) card.append(el("p", { class: "meta", text: row.category }));
  const fields = [
    ["ADDRESS", row.address],
    ["HOURS", row.hours],
  ];
  const dl = document.createElement("dl");
  for (const [label, value] of fields) {
    if (!value) continue;
    dl.append(el("dt", { text: label }), el("dd", { text: value }));
  }
  const phones = uniqueValues(row.phones?.length ? row.phones : [row.phone]);
  if (phones.length) {
    dl.append(el("dt", { text: phones.length > 1 ? "PHONES" : "PHONE" }));
    const dd = el("dd", { class: "stack" });
    for (const phone of phones) {
      const dial = phone.replace(/[^\d+]/g, "");
      dd.append(el("a", { href: `tel:${dial}`, text: phone }));
    }
    dl.append(dd);
  }
  const emails = uniqueValues(row.emails?.length ? row.emails : [row.email]);
  if (emails.length) {
    dl.append(el("dt", { text: emails.length > 1 ? "EMAILS" : "EMAIL" }));
    const dd = el("dd", { class: "stack" });
    for (const email of emails) dd.append(el("a", { href: `mailto:${email}`, text: email }));
    dl.append(dd);
  }
  const socials = Array.isArray(row.social) ? row.social : [];
  if (socials.length) {
    dl.append(el("dt", { text: "SOCIAL" }));
    const dd = el("dd", { class: "social-links" });
    for (const item of socials) {
      const href = safeHttp(item.url);
      if (!href) continue;
      dd.append(el("a", { href, text: item.platform || "Social", target: "_blank", rel: "noreferrer" }));
    }
    dl.append(dd);
  }
  const site = safeHttp(row.website);
  if (site) {
    dl.append(el("dt", { text: "WEBSITE" }));
    const dd = el("dd");
    dd.append(el("a", { href: site, text: site, target: "_blank", rel: "noreferrer" }));
    dl.append(dd);
  }
  const map = safeHttp(row.maps);
  if (map) {
    dl.append(el("dt", { text: "MAP" }));
    const dd = el("dd");
    dd.append(el("a", { href: map, text: "Open map", target: "_blank", rel: "noreferrer" }));
    dl.append(dd);
  }
  if (dl.childNodes.length) card.append(dl);
  if (row.about) card.append(el("p", { class: "meta", text: row.about }));
  if (site) {
    const more = actionButton("Is website ki poori detail", () => startScrape(site, ["email", "phone", "website", "social"]));
    more.classList.add("copy");
    card.append(more);
  }
  return card;
}

function uniqueValues(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const text = String(item || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function downloadDirectoryCsv(result) {
  const lines = [["name", "category", "address", "phones", "emails", "social", "website", "hours", "map"]];
  for (const row of result.businesses) {
    const phones = uniqueValues(row.phones?.length ? row.phones : [row.phone]).join(" | ");
    const emails = uniqueValues(row.emails?.length ? row.emails : [row.email]).join(" | ");
    const social = (row.social || []).map((item) => `${item.platform}: ${item.url}`).join(" | ");
    lines.push([row.name, row.category, row.address, phones, emails, social, row.website, row.hours, row.maps]);
  }
  const csv = lines.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${result.city}-${result.keyword}`.replace(/[^\w.-]+/g, "-").slice(0, 50) + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderSheet(dossier) {
  const business = dossier.business || {};
  sheet.hidden = false;
  sheet.replaceChildren();

  const top = el("div", { class: "sheet-top" });
  const heading = el("div");
  heading.append(
    el("p", { class: "kicker", text: "FINAL DATA" }),
    el("h1", { text: business.name || "Bina naam" })
  );
  const site = safeHttp(business.website);
  if (site) heading.append(el("a", { class: "website-link", href: site, text: site, target: "_blank", rel: "noreferrer" }));
  top.append(heading, el("div", { class: "stamp", text: "FINAL" }));
  sheet.append(top);

  if (business.logo && safeHttp(business.logo)) {
    const img = el("img", { class: "logo", alt: "" });
    img.src = safeHttp(business.logo);
    img.addEventListener("error", () => img.remove());
    sheet.append(img);
  }

  const counts = el("div", { class: "summary" });
  if (dossier.flags?.email) counts.append(el("span", { text: `${dossier.emails.length} emails` }));
  if (dossier.flags?.phone) counts.append(el("span", { text: `${dossier.phones.length} phones` }));
  if (dossier.flags?.social) counts.append(el("span", { text: `${dossier.social.length} social` }));
  counts.append(el("span", { text: `${dossier.pages.length} pages` }));
  sheet.append(counts);

  if (dossier.flags?.website && business.description) {
    sheet.append(block("WEBSITE", el("p", { class: "desc", text: business.description })));
  }
  if (dossier.flags?.website && business.category) {
    sheet.append(block("TYPE", el("p", { class: "address", text: business.category })));
  }
  const addresses = business.addresses?.length ? business.addresses : business.address ? [business.address] : [];
  if (dossier.flags?.website) {
    sheet.append(block("ADDRESS", addresses.length ? listText(addresses) : empty("Public address nahi mili.")));
  }
  if (dossier.flags?.website && business.hours?.length) {
    const ul = el("ul", { class: "hours" });
    for (const hour of business.hours) ul.append(el("li", { text: hour }));
    sheet.append(block("HOURS", ul));
  }
  if (dossier.flags?.email) {
    sheet.append(block("EMAILS", dossier.emails.length ? valueRows(dossier.emails) : empty("Email nahi mili.")));
  }
  if (dossier.flags?.phone) {
    sheet.append(block("PHONES", dossier.phones.length ? valueRows(dossier.phones) : empty("Phone nahi mila.")));
  }
  if (dossier.flags?.social) {
    sheet.append(block("SOCIAL", dossier.social.length ? socialRows(dossier.social) : empty("Social link nahi mila.")));
  }
  sheet.append(block("PAGES READ", pageRows(dossier.pages)));

  if (dossier.notes?.length) {
    const notes = el("div", { class: "notes" });
    for (const note of dossier.notes) notes.append(el("p", { class: "note", text: note }));
    sheet.append(notes);
  }

  const tools = el("div", { class: "tools" });
  tools.append(
    actionButton("Copy JSON", () => copyText(JSON.stringify(dossier, null, 2))),
    actionButton("Download CSV", () => downloadCsv(dossier)),
    actionButton("Print", () => window.print())
  );
  sheet.append(tools);
  sheet.scrollIntoView({ behavior: "smooth", block: "start" });
}

function valueRows(items) {
  const wrap = el("div", { class: "rows" });
  for (const item of items) {
    const row = el("div", { class: "row" });
    row.append(
      el("strong", { text: item.value }),
      el("span", { class: "source", text: sourceLabel(item.sources) }),
      actionButton("Copy", () => copyText(item.value), "copy")
    );
    wrap.append(row);
  }
  return wrap;
}

function socialRows(items) {
  const wrap = el("div", { class: "rows" });
  for (const item of items) {
    const card = el("article", { class: "social-card" });
    const head = document.createElement("header");
    head.append(el("h3", { text: item.platform || "Social" }), el("span", { class: "pill", text: statusLabel(item.status) }));
    card.append(head);
    const href = safeHttp(item.url);
    if (href) card.append(el("a", { href, text: href, target: "_blank", rel: "noreferrer" }));
    if (item.title) card.append(el("p", { text: item.title }));
    if (item.description && item.description !== item.title) card.append(el("p", { text: item.description }));
    wrap.append(card);
  }
  return wrap;
}

function pageRows(pages) {
  const wrap = el("div", { class: "pages" });
  if (!pages.length) return empty("Koi page nahi khula.");
  for (const page of pages) {
    const row = el("div");
    const href = safeHttp(page.url);
    row.append(href ? el("a", { href, text: page.title || href, target: "_blank", rel: "noreferrer" }) : el("span", { text: page.url }));
    row.append(el("span", { class: page.ok ? "source" : "bad", text: page.ok ? String(page.status || "ok") : page.error || "fail" }));
    wrap.append(row);
  }
  return wrap;
}

function listText(items) {
  const wrap = el("div", { class: "rows" });
  for (const item of items) wrap.append(el("p", { class: "address", text: item }));
  return wrap;
}

function block(title, child) {
  const section = el("section", { class: "block" });
  section.append(el("h2", { text: title }), child);
  return section;
}

function empty(text) {
  return el("p", { class: "empty", text });
}

function actionButton(text, onClick, className = "file-btn") {
  const button = el("button", { class: className, type: "button", text });
  button.addEventListener("click", onClick);
  return button;
}

function statusLabel(status) {
  if (status === "public") return "Public";
  if (status === "limited") return "Thori si detail";
  if (status === "blocked") return "Page nahi khula";
  return "Link mila";
}

function sourceLabel(sources) {
  if (!sources?.length) return "";
  try {
    const host = new URL(sources[0]).hostname.replace(/^www\./, "");
    return sources.length > 1 ? `${host} +${sources.length - 1}` : host;
  } catch {
    return "";
  }
}

function downloadCsv(dossier) {
  const lines = [["section", "value", "detail", "sources"]];
  const push = (section, value, detail, sources) => {
    lines.push([section, value || "", detail || "", (sources || []).join(" ")]);
  };
  const business = dossier.business || {};
  push("name", business.name);
  push("website", business.website);
  push("description", business.description);
  push("address", (business.addresses || []).join(" | "));
  push("category", business.category);
  for (const email of dossier.emails || []) push("email", email.value, email.confidence, email.sources);
  for (const phone of dossier.phones || []) push("phone", phone.value, phone.confidence, phone.sources);
  for (const social of dossier.social || []) push("social", social.url, `${social.platform} ${social.status}`, [social.description]);
  for (const page of dossier.pages || []) push("page", page.url, page.ok ? "ok" : page.error);
  const csv = lines.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(business.name || "daftar").replace(/[^\w.-]+/g, "-").slice(0, 40)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    show(statusEl, "Copy ho gaya.");
  } catch {
    showError("Copy nahi ho saka.");
  }
}

function remember(query, name, mode) {
  const key = "daftar-history";
  const prev = JSON.parse(localStorage.getItem(key) || "[]");
  const next = [{ query, name, mode: mode || "page", at: Date.now() }, ...prev.filter((item) => item.query !== query)].slice(0, 8);
  localStorage.setItem(key, JSON.stringify(next));
  renderHistory();
}

function renderHistory() {
  document.querySelector(".history")?.remove();
  const items = JSON.parse(localStorage.getItem("daftar-history") || "[]");
  if (!items.length) return;
  const wrap = el("div", { class: "history" });
  wrap.append(el("span", { text: "Pichli" }));
  for (const item of items) {
    const button = el("button", { type: "button", text: item.name || item.query });
    button.addEventListener("click", () => {
      if (item.mode === "directory") {
        const [keyword, city] = String(item.query).split(" · ");
        if (keyword) keywordEl.value = keyword;
        const option = [...cityEl.options].find((entry) => entry.value.toLowerCase() === String(city || "").toLowerCase());
        if (option) cityEl.value = option.value;
        directoryForm.requestSubmit();
        return;
      }
      queryEl.value = item.query;
      form.requestSubmit();
    });
    wrap.append(button);
  }
  form.append(wrap);
}

function showError(message) {
  hide(statusEl);
  show(errorEl, message);
}

function show(node, text) {
  node.hidden = false;
  node.textContent = text;
}

function hide(node) {
  node.hidden = true;
  node.textContent = "";
}

function safeHttp(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  return node;
}
