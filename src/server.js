// Server entry point. The CLI spawns `node src/server.js <root>` as a
// detached process. SKETCHBOARD_IDLE_MS overrides the idle timeout (tests only).
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_PREFIX,
  DEFAULT_PORT,
  ENDPOINTS,
  HOST,
  IDLE_TIMEOUT_MS,
  INDEX_FILE,
  SSE_KEEPALIVE_MS,
  SYSTEM_DIR,
  TOOL_PREFIX,
  emptyIndex,
} from "./protocol.js";
import { boardNameError, canvasNameError, ensureStateDir, indexFile, insideRoot, readIndex, resolveInside, rootFile, serverFile } from "./paths.js";

/**
 * @typedef {import("./protocol.js").FeedbackItem} FeedbackItem
 * @typedef {import("./protocol.js").EditItem} EditItem
 * @typedef {import("./protocol.js").ServerEvent} ServerEvent
 * @typedef {import("./protocol.js").ServerState} ServerState
 * @typedef {import("./protocol.js").CanvasSummary} CanvasSummary
 * @typedef {import("node:http").IncomingMessage} Req
 * @typedef {import("node:http").ServerResponse} Res
 * @typedef {{ canvas: string | null, res: Res, timer?: NodeJS.Timeout, closeTimer?: NodeJS.Timeout }} Waiter
 */

const PROTOCOL_FILE = fileURLToPath(new URL("./protocol.js", import.meta.url));
const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const OVERLAY_TAG = `<script type="module" src="${TOOL_PREFIX}overlay.js"></script>`;
const MAX_BODY = 10 * 1024 * 1024;
const DEBOUNCE_MS = 75;

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const root = path.resolve(process.argv[2] ?? process.cwd());
const idleMs = Number(process.env.SKETCHBOARD_IDLE_MS) || IDLE_TIMEOUT_MS;
const stateFile = serverFile(root);

/** @type {Map<string, FeedbackItem[]>} */
const held = new Map();
/** @type {Waiter[]} */
const waiters = [];
/** @type {Map<Res, string>} */
const streams = new Map();
/** @type {Map<string, import("node:fs").FSWatcher>} */
const watchers = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const pending = new Map();
let port = DEFAULT_PORT;
/** @type {NodeJS.Timeout | undefined} */
let idleTimer;
let stopping = false;
/** Time of the last request (other than wait and status) or closed event stream, for the idle stop. */
let lastActivity = Date.now();
const startedAt = Date.now();
/** @type {Map<string, number>} When each canvas's last tab closed, or the canvas was last opened. */
const lastTabClosed = new Map();
/** When the last tab on any canvas closed, or any canvas was last opened. */
let lastAnyTabClosed = 0;

ensureStateDir(root);
const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    else res.destroy();
  });
});
server.on("error", (err) => {
  if (/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE" && port !== 0) {
    port = 0;
    server.listen(0, HOST);
  } else {
    throw err;
  }
});
server.on("listening", () => {
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : port;
  /** @type {ServerState} */
  const state = { v: 1, pid: process.pid, port, url: `http://${HOST}:${port}`, root, startedAt: new Date().toISOString() };
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, stateFile);
  touch();
});
server.listen(port, HOST);

const keepalive = setInterval(() => {
  for (const res of streams.keys()) res.write(": keepalive\n\n");
}, SSE_KEEPALIVE_MS);
keepalive.unref();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Idle stop: any request restarts the countdown; the countdown runs only while
// no event stream is open and no wait is in progress.

/** @param {number} [delay] */
function touch(delay = idleMs) {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (stopping || streams.size > 0 || waiters.length > 0) return;
  idleTimer = setTimeout(shutdown, delay);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  for (const res of streams.keys()) res.end();
  for (const w of watchers.values()) w.close();
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (state.pid === process.pid) unlinkSync(stateFile);
  } catch {
    // Missing or unreadable: nothing of ours to delete.
  }
  server.close();
  server.closeAllConnections();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Routing

/**
 * @param {Req} req
 * @param {Res} res
 */
async function handle(req, res) {
  const host = req.headers.host;
  if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
    return sendJson(res, 403, { error: "forbidden host" });
  }
  const origin = req.headers.origin;
  if (req.method === "POST" && origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
    return sendJson(res, 403, { error: "forbidden origin" });
  }
  const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
  const p = url.pathname;
  const site = req.headers["sec-fetch-site"];
  if (p.startsWith(API_PREFIX) && site !== undefined && site !== "same-origin" && site !== "none") {
    return sendJson(res, 403, { error: "forbidden cross-site request" });
  }
  // A wait loop (each CLI run also probes status) must not hold off the idle stop after its wait closes.
  if (p !== ENDPOINTS.wait.path && p !== ENDPOINTS.status.path) lastActivity = Date.now();
  touch();
  const method = req.method ?? "GET";

  if (p.startsWith(API_PREFIX)) return api(req, res, method, p.slice(API_PREFIX.length), url.searchParams);
  if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
  if (p === "/") return serveUi(res, "shell.html");
  const shell = /^\/c\/([^/]+)\/?$/.exec(p);
  if (shell) {
    const err = canvasNameError(safeDecode(shell[1]));
    return err ? sendJson(res, 400, { error: err }) : serveUi(res, "shell.html");
  }
  if (p === `${TOOL_PREFIX}protocol.js`) return serveFile(res, PROTOCOL_FILE, false);
  if (p.startsWith(TOOL_PREFIX)) return serveUi(res, p.slice(TOOL_PREFIX.length));
  if (p.startsWith("/design/")) return serveDesign(res, p.slice("/design/".length), url.searchParams.get("raw") !== "1");
  return sendJson(res, 404, { error: "not found" });
}

/**
 * @param {Req} req
 * @param {Res} res
 * @param {string} method
 * @param {string} route
 * @param {URLSearchParams} query
 */
async function api(req, res, method, route, query) {
  const canvasRoute = /^canvas\/([^/]+)(\/notes)?$/.exec(route);
  /** @type {Record<string, [string, () => unknown]>} */
  const routes = {
    open: ["POST", () => readBody(req).then((b) => apiOpen(res, b))],
    canvases: ["GET", () => sendJson(res, 200, { canvases: summaries() })],
    events: ["GET", () => apiEvents(req, res, query)],
    send: ["POST", () => readBody(req).then((b) => apiSend(res, b))],
    edit: ["POST", () => readBody(req).then((b) => apiEdit(res, b))],
    wait: ["GET", () => apiWait(res, query)],
    status: ["GET", () => apiStatus(res)],
    stop: ["POST", () => apiStop(res)],
  };
  /** @type {[string, () => unknown] | undefined} */
  let entry = routes[route];
  if (canvasRoute) {
    const canvas = safeDecode(canvasRoute[1]) ?? "";
    entry = canvasRoute[2]
      ? ["POST", () => readBody(req).then((b) => apiNotes(res, canvas, b))]
      : ["GET", () => apiIndex(res, canvas)];
  }
  if (!entry) return sendJson(res, 404, { error: "not found" });
  if (entry[0] !== method) return sendJson(res, 405, { error: "method not allowed" });
  return entry[1]();
}

// ---------------------------------------------------------------------------
// API handlers

/**
 * @param {Res} res
 * @param {any} body
 */
async function apiOpen(res, body) {
  const canvas = body?.canvas;
  const err = canvasNameError(canvas);
  if (err) return sendJson(res, 400, { error: err });
  ensureStateDir(root);
  const dir = path.join(root, canvas);
  mkdirSync(dir, { recursive: true });
  if (!insideRoot(await realpath(dir), await realpath(root))) {
    return sendJson(res, 400, { error: `${dir} resolves outside ${root}` });
  }
  let created = false;
  try {
    writeFileSync(indexFile(root, canvas), JSON.stringify(emptyIndex(canvas), null, 2) + "\n", { flag: "wx" });
    created = true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
  }
  // The user gets a fresh idle time to open the URL, even on a server that has run longer than that.
  lastTabClosed.set(canvas, Date.now());
  lastAnyTabClosed = Date.now();
  for (const w of waiters) {
    if (w.canvas === null || w.canvas === canvas) {
      clearTimeout(w.closeTimer);
      w.closeTimer = undefined;
    }
  }
  scheduleWaitClose();
  sendJson(res, 200, { url: `http://${HOST}:${port}/c/${canvas}`, created });
}

/** @returns {CanvasSummary[]} */
function summaries() {
  /** @type {CanvasSummary[]} */
  const list = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const e of entries) {
    if (!e.isDirectory() || canvasNameError(e.name) || !existsSync(indexFile(root, e.name))) continue;
    let title = e.name;
    try {
      title = readIndex(root, e.name).title ?? e.name;
    } catch {
      // Invalid JSON: list the canvas under its folder name.
    }
    list.push({ name: e.name, title, held: held.get(e.name)?.length ?? 0, tabs: tabCount(e.name) });
  }
  return list;
}

/** @param {string} canvas */
function tabCount(canvas) {
  let n = 0;
  for (const c of streams.values()) if (c === canvas) n++;
  return n;
}

/**
 * @param {Res} res
 * @param {string} canvas
 */
function apiIndex(res, canvas) {
  const err = canvasNameError(canvas);
  if (err) return sendJson(res, 400, { error: err });
  if (!existsSync(indexFile(root, canvas))) return sendJson(res, 404, { error: `no canvas "${canvas}"` });
  try {
    sendJson(res, 200, readIndex(root, canvas));
  } catch (e) {
    sendJson(res, 422, { error: `${canvas}/${INDEX_FILE}: ${/** @type {Error} */ (e).message}` });
  }
}

/**
 * Re-reads canvas.json right before the write so concurrent agent edits survive.
 * @param {Res} res
 * @param {string} canvas
 * @param {any} body
 */
async function apiNotes(res, canvas, body) {
  const err = canvasNameError(canvas);
  if (err) return sendJson(res, 400, { error: err });
  const file = await rootFile(root, [canvas, INDEX_FILE]);
  if (!file) return sendJson(res, 404, { error: `no canvas "${canvas}"` });
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    return code === "ENOENT"
      ? sendJson(res, 404, { error: `no canvas "${canvas}"` })
      : sendJson(res, 422, { error: `${canvas}/${INDEX_FILE}: ${/** @type {Error} */ (e).message}` });
  }
  const notes = { ...(raw.notes ?? {}), ...(body?.set ?? {}) };
  for (const id of body?.remove ?? []) delete notes[id];
  raw.notes = notes;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  sendJson(res, 200, { notes });
}

/**
 * @param {Req} req
 * @param {Res} res
 * @param {URLSearchParams} query
 */
function apiEvents(req, res, query) {
  const canvas = query.get("canvas");
  const err = canvasNameError(canvas);
  if (err || canvas === null) return sendJson(res, 400, { error: err ?? "canvas is required" });
  if (!existsSync(indexFile(root, canvas))) return sendJson(res, 404, { error: `no canvas "${canvas}"` });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  streams.set(res, canvas);
  watchCanvas(canvas);
  watchSystems();
  scheduleWaitClose();
  touch();
  req.on("close", () => {
    streams.delete(res);
    lastActivity = Date.now();
    lastTabClosed.set(canvas, lastActivity);
    lastAnyTabClosed = lastActivity;
    unwatchUnused();
    scheduleWaitClose();
    touch();
  });
}

/**
 * @param {Res} res
 * @param {any} body
 */
function apiSend(res, body) {
  const canvas = body?.canvas;
  const err = canvasNameError(canvas);
  if (err) return sendJson(res, 400, { error: err });
  if (!Array.isArray(body.items)) return sendJson(res, 400, { error: "items must be an array" });
  const list = held.get(canvas) ?? [];
  list.push(...body.items);
  if (typeof body.message === "string" && body.message.trim() !== "") list.push({ kind: "message", text: body.message });
  held.set(canvas, list);
  const count = list.length;
  deliver();
  sendJson(res, 200, { held: count });
}

/**
 * @param {Res} res
 * @param {any} body
 */
async function apiEdit(res, body) {
  const { canvas, board, selector, oldText, newText } = body ?? {};
  const err = canvasNameError(canvas) ?? boardNameError(board);
  if (err) return sendJson(res, 400, { error: err });
  if (typeof oldText !== "string" || typeof newText !== "string") {
    return sendJson(res, 400, { error: "oldText and newText must be strings" });
  }
  let boards;
  try {
    boards = readIndex(root, canvas).boards;
  } catch {
    return sendJson(res, 404, { error: `no canvas "${canvas}"` });
  }
  if (!/\.html?$/i.test(board) || !Object.hasOwn(boards, board)) {
    return sendJson(res, 400, { error: `"${board}" is not an HTML board in ${canvas}/${INDEX_FILE}` });
  }
  const file = await rootFile(root, [canvas, board]);
  if (!file) return sendJson(res, 404, { error: `no board file "${canvas}/${board}" inside the root folder` });
  // Read and write in one synchronous step so concurrent edits cannot interleave.
  const source = readFileSync(file, "utf8");
  const found = oldText === "" ? null : editTarget(source, oldText);
  const applied = found !== null;
  if (found) writeFileSync(file, source.slice(0, found[0]) + escapeText(newText) + source.slice(found[1]));
  /** @type {EditItem} */
  const item = { kind: "edit", board, selector: String(selector ?? ""), oldText, newText, applied };
  sendJson(res, 200, { item });
}

/** Elements whose contents are not visible page text. */
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "template", "noscript", "textarea"]);

/**
 * The source range [start, end) of the one occurrence of `needle` in the
 * visible text of `html`, or null if it occurs zero or several times there,
 * or occurs anywhere in <script> content, as written or decoded (a script may
 * render it too).
 * Visible text excludes tags (and so attribute values), comments, and the
 * contents of RAW_TEXT_TAGS. It is compared after decoding character
 * references and turning CRLF and CR into LF, as the DOM's textContent does.
 * A match may not cross a tag.
 * @param {string} html
 * @param {string} needle
 * @returns {[number, number] | null}
 */
function editTarget(html, needle) {
  const { text, script } = regions(html);
  const inScript = (/** @type {[number, number]} */ [start, end]) => html.slice(start, end).includes(needle) || decodeText(html, start, end).decoded.includes(needle);
  if (script.some(inScript)) return null;
  /** @type {[number, number] | null} */
  let found = null;
  for (const [start, end] of text) {
    const { decoded, offsets } = decodeText(html, start, end);
    for (let at = decoded.indexOf(needle); at !== -1; at = decoded.indexOf(needle, at + 1)) {
      if (found) return null;
      found = [offsets[at], offsets[at + needle.length]];
    }
  }
  return found;
}

/** Named character references that agent-written HTML commonly uses. Others stay literal. */
const NAMED_REFS = new Map(
  Object.entries({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
    hellip: "…", rarr: "→", larr: "←", uarr: "↑", darr: "↓", copy: "©",
    reg: "®", trade: "™", middot: "·", bull: "•", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“", times: "×", deg: "°", euro: "€", pound: "£",
  }),
);

/**
 * Decodes html[start, end) as page text. offsets[k] is the source offset where
 * decoded character k starts; offsets[decoded.length] is `end`.
 * @param {string} html
 * @param {number} start
 * @param {number} end
 */
function decodeText(html, start, end) {
  let decoded = "";
  /** @type {number[]} */
  const offsets = [];
  const ref = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/y;
  let i = start;
  while (i < end) {
    let out = html[i];
    let next = i + 1;
    if (html[i] === "\r") {
      out = "\n";
      if (html[i + 1] === "\n") next = i + 2;
    } else if (html[i] === "&") {
      ref.lastIndex = i;
      const m = ref.exec(html);
      const value = m && (m[3] !== undefined ? NAMED_REFS.get(m[3]) : codePoint(Number.parseInt(m[1] ?? m[2], m[1] ? 10 : 16)));
      if (m && typeof value === "string") {
        out = value;
        next = i + m[0].length;
      }
    }
    for (let k = 0; k < out.length; k++) offsets.push(i);
    decoded += out;
    i = next;
  }
  offsets.push(end);
  return { decoded, offsets };
}

/**
 * The text for a numeric character reference: U+FFFD for 0, surrogates, and values past U+10FFFF.
 * @param {number} n
 */
function codePoint(n) {
  return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "�" : String.fromCodePoint(n);
}

/**
 * [start, end) ranges of the text between markup in `html`, and of the
 * contents of each <script> element.
 * @param {string} html
 */
function regions(html) {
  /** @type {[number, number][]} */
  const text = [];
  /** @type {[number, number][]} */
  const script = [];
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<" || !/[A-Za-z/!?]/.test(html[i + 1] ?? "")) {
      i++;
      continue;
    }
    if (i > textStart) text.push([textStart, i]);
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? html.length : close + 3;
    } else {
      const name = /^<([A-Za-z][^\s/>]*)/.exec(html.slice(i, i + 32))?.[1].toLowerCase();
      i = tagEnd(html, i);
      if (name !== undefined && RAW_TEXT_TAGS.has(name)) {
        const close = new RegExp(`</${name}[\\s/>]`, "ig");
        close.lastIndex = i;
        const m = close.exec(html);
        const contentEnd = m ? m.index : html.length;
        if (name === "script") script.push([i, contentEnd]);
        i = m ? tagEnd(html, m.index) : html.length;
      }
    }
    textStart = i;
  }
  if (html.length > textStart) text.push([textStart, html.length]);
  return { text, script };
}

/**
 * Offset just past the ">" that ends the tag starting at `i`. A quote opens an attribute value only after "=".
 * @param {string} html
 * @param {number} i
 */
function tagEnd(html, i) {
  /** @type {string | null} */
  let quote = null;
  let afterEquals = false;
  for (let j = i + 1; j < html.length; j++) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (afterEquals && (c === '"' || c === "'")) {
      quote = c;
    } else if (c === ">") {
      return j + 1;
    }
    if (!/\s/.test(c)) afterEquals = !quote && c === "=";
  }
  return html.length;
}

/** @param {string} s */
function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {Res} res
 * @param {URLSearchParams} query
 */
function apiWait(res, query) {
  const canvas = query.get("canvas") || null;
  if (canvas !== null) {
    const err = canvasNameError(canvas);
    if (err) return sendJson(res, 400, { error: err });
  }
  const t = query.has("timeout") ? Number(query.get("timeout")) : NaN;
  const ready = take(canvas);
  if (ready) return sendJson(res, 200, ready);
  /** @type {Waiter} */
  const waiter = { canvas, res };
  if (Number.isFinite(t) && t >= 0) {
    waiter.timer = setTimeout(() => {
      removeWaiter(waiter);
      sendJson(res, 200, { canvas, items: [], timedOut: true });
    }, Math.min(t * 1000, 2 ** 31 - 1));
  }
  waiters.push(waiter);
  res.on("close", () => removeWaiter(waiter));
  scheduleWaitClose();
  touch();
}

/**
 * Starts the close countdown of each wait with no tab open on its canvas (any
 * canvas for a wait without one), and stops it for waits that have one. The
 * countdown runs from the later of when that canvas last had a tab open and
 * when it was last opened, across waits (from server start if neither), so a
 * loop of short waits still closes, and a wait that starts after `idleMs`
 * without either closes at once.
 */
function scheduleWaitClose() {
  const open = new Set(streams.values());
  for (const w of waiters) {
    const hasTab = w.canvas === null ? open.size > 0 : open.has(w.canvas);
    if (hasTab) {
      clearTimeout(w.closeTimer);
      w.closeTimer = undefined;
    } else if (!w.closeTimer) {
      const lastTab = (w.canvas === null ? lastAnyTabClosed : lastTabClosed.get(w.canvas)) || startedAt;
      const delay = Math.max(0, lastTab + idleMs - Date.now());
      w.closeTimer = setTimeout(() => closeWait(w), Math.min(delay, 2 ** 31 - 1));
    }
  }
}

/**
 * Ends a wait whose canvas had no tab for `idleMs`. Held feedback stays held.
 * The idle stop then counts from the last real activity, so with no tab and
 * no other request in that time the server stops right after the reply.
 * @param {Waiter} w
 */
function closeWait(w) {
  removeWaiter(w);
  w.res.once("finish", () => touch(Math.max(0, lastActivity + idleMs - Date.now())));
  sendJson(w.res, 200, { canvas: w.canvas, items: [], closed: true });
}

/** @param {Waiter} w */
function removeWaiter(w) {
  const i = waiters.indexOf(w);
  if (i === -1) return; // Already removed; a second touch would restart the idle countdown.
  waiters.splice(i, 1);
  clearTimeout(w.timer);
  clearTimeout(w.closeTimer);
  touch();
}

/**
 * Removes and returns held feedback for `canvas`, or for the first canvas
 * with held feedback when `canvas` is null.
 * @param {string | null} canvas
 */
function take(canvas) {
  for (const [name, items] of held) {
    if (items.length > 0 && (canvas === null || canvas === name)) {
      held.delete(name);
      return { canvas: name, items };
    }
  }
  return null;
}

function deliver() {
  for (const w of [...waiters]) {
    const ready = take(w.canvas);
    if (!ready) continue;
    removeWaiter(w);
    sendJson(w.res, 200, ready);
  }
}

/** @param {Res} res */
function apiStatus(res) {
  sendJson(res, 200, { url: `http://${HOST}:${port}`, root, pid: process.pid, canvases: summaries(), waiting: waiters.length });
}

/** @param {Res} res */
function apiStop(res) {
  res.on("finish", () => setImmediate(shutdown));
  sendJson(res, 200, { stopping: true });
}

// ---------------------------------------------------------------------------
// File watching. Watchers exist only while event streams are open. Each
// watcher is non-recursive so it behaves the same on every OS.

/** @param {string} canvas */
function watchCanvas(canvas) {
  const key = `canvas:${canvas}`;
  if (watchers.has(key)) return;
  addWatcher(key, path.join(root, canvas), (file) => {
    if (file === INDEX_FILE) {
      sendIndex(canvas);
    } else {
      debounce(key + "\0" + file, () => broadcast({ type: "board", canvas, board: file }, canvas));
    }
  });
}

/** @param {string} canvas */
function sendIndex(canvas) {
  debounce(`canvas:${canvas}\0${INDEX_FILE}`, () => {
    let index;
    try {
      index = readIndex(root, canvas);
    } catch {
      return; // Missing or half-written: the next change event sends it.
    }
    broadcast({ type: "index", canvas, index }, canvas);
  });
}

const systemsDir = path.join(root, SYSTEM_DIR);
const systemChanged = () => debounce("system", () => broadcast({ type: "system" }, null));

/**
 * Watches the root (for canvas and systems/ folders that are deleted and
 * created again), systems/, and each systems/<name>/.
 */
function watchSystems() {
  if (!watchers.has("root")) {
    addWatcher("root", root, (file) => {
      if (file === SYSTEM_DIR) {
        closeWatcher("systems");
        watchSystems();
        systemChanged();
      } else if (new Set(streams.values()).has(file)) {
        closeWatcher(`canvas:${file}`);
        watchCanvas(file);
        sendIndex(file); // canvas.json may have been written before the new watcher started.
      }
    });
  }
  if (!watchers.has("systems")) {
    addWatcher("systems", systemsDir, (name) => {
      closeWatcher(`system:${name}`);
      watchSystem(name);
      systemChanged();
    });
  }
  /** @type {import("node:fs").Dirent[]} */
  let entries = [];
  try {
    entries = readdirSync(systemsDir, { withFileTypes: true });
  } catch {
    // No systems/ folder yet; the root watcher adds it when it appears.
  }
  for (const e of entries) if (e.isDirectory()) watchSystem(e.name);
}

/** @param {string} name */
function watchSystem(name) {
  const key = `system:${name}`;
  const dir = path.join(systemsDir, name);
  if (watchers.has(key) || !isDir(dir)) return;
  addWatcher(key, dir, systemChanged);
}

/** @param {string} key */
function closeWatcher(key) {
  watchers.get(key)?.close();
  watchers.delete(key);
}

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 * @param {string} dir
 * @param {(file: string) => void} onFile
 */
function addWatcher(key, dir, onFile) {
  let w;
  try {
    w = watch(dir, (_event, file) => {
      if (file) onFile(String(file));
    });
  } catch {
    return; // The folder does not exist; nothing to watch.
  }
  w.on("error", () => {
    w.close();
    if (watchers.get(key) === w) watchers.delete(key);
  });
  watchers.set(key, w);
}

function unwatchUnused() {
  const open = new Set(streams.values());
  for (const [key, w] of watchers) {
    const keep = key.startsWith("canvas:") ? open.has(key.slice("canvas:".length)) : open.size > 0;
    if (!keep) {
      w.close();
      watchers.delete(key);
    }
  }
}

/**
 * @param {string} key
 * @param {() => void} fn
 */
function debounce(key, fn) {
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      fn();
    }, DEBOUNCE_MS),
  );
}

/**
 * @param {ServerEvent} event
 * @param {string | null} canvas null sends to every stream.
 */
function broadcast(event, canvas) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const [res, c] of streams) if (canvas === null || c === canvas) res.write(data);
}

// ---------------------------------------------------------------------------
// Static files

/**
 * @param {Res} res
 * @param {string} rel URL path relative to ui/, still percent-encoded.
 */
async function serveUi(res, rel) {
  const segments = urlSegments(rel);
  const file = segments && (await resolveInside(UI_DIR, segments));
  if (!file) return sendJson(res, 404, { error: `ui file not found: ${rel}` });
  return serveFile(res, file, false);
}

/**
 * @param {Res} res
 * @param {string} rel URL path after /design/, still percent-encoded.
 * @param {boolean} inject
 */
async function serveDesign(res, rel, inject) {
  const segments = urlSegments(rel);
  const file = segments && (await rootFile(root, segments));
  if (!file) return sendJson(res, 404, { error: "not found" });
  return serveFile(res, file, inject);
}

/**
 * Decodes a percent-encoded relative URL path into path segments, or returns
 * null if a segment is empty, "." or "..", or holds a separator.
 * @param {string} rel
 */
function urlSegments(rel) {
  const segments = rel.split("/").map((s) => safeDecode(s) ?? "");
  return segments.some((s) => s === "" || s === "." || s === ".." || /[\\/\0:]/.test(s)) ? null : segments;
}

/**
 * @param {Res} res
 * @param {string} file
 * @param {boolean} inject Add the overlay script to HTML.
 */
async function serveFile(res, file, inject) {
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  /** @type {string | Buffer} */
  let body = await readFile(file);
  if (inject && type.startsWith("text/html")) {
    const html = body.toString("utf8");
    const at = html.toLowerCase().lastIndexOf("</body>");
    body = at === -1 ? html + OVERLAY_TAG : html.slice(0, at) + OVERLAY_TAG + html.slice(at);
  }
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {string} s
 * @returns {string | null}
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * @param {Req} req
 * @returns {Promise<any>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("request body is not valid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
