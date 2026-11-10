import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./scraper.js";
import { searchDirectory } from "./directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT) || 4173;
const host = "127.0.0.1";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}`);
  if (req.method === "POST" && url.pathname === "/api/scrape") {
    await handleScrape(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/directory") {
    await handleDirectory(req, res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const file = path.resolve(publicDir, rel);
  const fromRoot = path.relative(publicDir, file);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    const type = types[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
});

async function handleScrape(req, res) {
  const payload = await readJson(req, res);
  if (!payload) return;
  const events = openEvents(req, res);
  try {
    const dossier = await buildDossier(payload.query, {
      email: payload.email !== false,
      phone: payload.phone !== false,
      website: payload.website !== false,
      social: payload.social !== false,
      signal: events.controller.signal,
      onEvent: (event) => events.send("status", event),
    });
    events.send("done", dossier);
  } catch (error) {
    if (error?.name !== "AbortError") {
      events.send("error", { message: error?.message || "Scrape fail ho gaya." });
    }
  } finally {
    events.finish();
  }
}

async function handleDirectory(req, res) {
  const payload = await readJson(req, res);
  if (!payload) return;
  const events = openEvents(req, res);
  try {
    const result = await searchDirectory(
      { country: payload.country, city: payload.city, keyword: payload.keyword },
      {
        signal: events.controller.signal,
        onEvent: (event) => events.send("status", event),
      }
    );
    events.send("done", result);
  } catch (error) {
    if (error?.name !== "AbortError") {
      events.send("error", { message: error?.message || "Search fail ho gayi." });
    }
  } finally {
    events.finish();
  }
}

async function readJson(req, res) {
  let body = "";
  try {
    body = await readReq(req);
  } catch {
    send(res, 400, "Request parhi nahi gayi.");
    return null;
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    send(res, 400, "JSON theek nahi hai.");
    return null;
  }
}

function openEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const controller = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
  });
  return {
    controller,
    send(event, data) {
      if (finished) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    finish() {
      finished = true;
      res.end();
    },
  };
}

function readReq(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 50_000) {
        reject(new Error("too big"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

server.listen(port, host, () => {
  console.log(`DAFTAR http://${host}:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} pehle se use ho raha hai. http://${host}:${port} khol lo, ya PORT badal ke chalao.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
