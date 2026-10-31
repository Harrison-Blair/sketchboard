import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { STATE_DIR } from "./protocol.js";
import { boardNameError, canvasNameError, indexFile, rootFile, sketchRoot } from "./paths.js";
import { api, ensureServer, findServer } from "./client.js";
import { findBrowser, takeShot } from "./shot.js";

const USAGE = `Usage:
  sketchboard open <canvas>
  sketchboard wait [<canvas>] [--timeout <s>]   (no timeout unless given)
  sketchboard locate <canvas> <file>   (file: saved wait output, or its items array)
  sketchboard status
  sketchboard stop
  sketchboard shot <canvas> <board>
  sketchboard --version`;

class UsageError extends Error {}

/** @param {string[]} args */
async function main(args) {
  const [command, ...rest] = args;
  if (command === "--version") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  const root = sketchRoot();
  switch (command) {
    case "open":
      return open(root, rest);
    case "wait":
      return wait(root, rest);
    case "locate":
      return locate(root, rest);
    case "status":
      return status(root, rest);
    case "stop":
      return stop(root, rest);
    case "shot":
      return shot(root, rest);
    default:
      throw new UsageError(command === undefined ? "missing command" : `unknown command "${command}"`);
  }
}

/**
 * @param {string[]} args
 * @param {number} count
 */
function positionals(args, count) {
  if (args.length !== count) throw new UsageError(`expected ${count} argument${count === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

/** @param {string} name */
function checkCanvas(name) {
  const err = canvasNameError(name);
  if (err) throw new Error(err);
  return name;
}

/** @param {{ status: number, json: any }} reply */
function ok(reply) {
  if (reply.status < 200 || reply.status >= 300) throw new Error(reply.json?.error ?? `server returned ${reply.status}`);
  return reply.json;
}

/**
 * @param {string} root
 * @param {string[]} args
 */
async function open(root, args) {
  const [canvas] = positionals(args, 1);
  checkCanvas(canvas);
  const server = await ensureServer(root);
  /** @type {import("./protocol.js").OpenResponse} */
  const res = ok(await api(server.port, "POST", "open", { canvas }));
  if (res.created) console.log(`Created ${indexFile(root, canvas)}`);
  console.log(res.url);
}

/**
 * @param {string} root
 * @param {string[]} args
 */
async function wait(root, args) {
  /** @type {string | undefined} */
  let canvas;
  /** @type {number | undefined} */
  let timeout;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--timeout" || a.startsWith("--timeout=")) {
      const value = a === "--timeout" ? args[++i] : a.slice("--timeout=".length);
      timeout = Number(value);
      if (!value || !Number.isFinite(timeout) || timeout < 0) throw new UsageError("--timeout needs a number of seconds, 0 or more");
    } else if (a.startsWith("-")) {
      throw new UsageError(`unknown option "${a}"`);
    } else if (canvas === undefined) {
      canvas = checkCanvas(a);
    } else {
      throw new UsageError(`unexpected argument "${a}"`);
    }
  }
  const server = await ensureServer(root);
  const query = new URLSearchParams();
  if (timeout !== undefined) query.set("timeout", String(timeout));
  if (canvas !== undefined) query.set("canvas", canvas);
  let reply;
  try {
    reply = await api(server.port, "GET", `wait?${query}`);
  } catch (err) {
    throw new Error(`lost the connection to the server: ${/** @type {Error} */ (err).message}`);
  }
  process.stdout.write(JSON.stringify(ok(reply)) + "\n");
}

/**
 * Prints saved `wait` items with their source positions recomputed against the board files now.
 * @param {string} root
 * @param {string[]} args
 */
async function locate(root, args) {
  const [canvas, file] = positionals(args, 2);
  checkCanvas(canvas);
  const bytes = readFileSync(file);
  // Windows PowerShell 5.1 redirection writes UTF-16LE with a BOM.
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le") : bytes.toString("utf8");
  let saved;
  try {
    saved = JSON.parse(text.replace(/^\ufeff/, ""));
  } catch (err) {
    throw new Error(`${file} is not JSON: ${/** @type {Error} */ (err).message}`);
  }
  const items = Array.isArray(saved) ? saved : saved?.items;
  if (!Array.isArray(items)) throw new Error(`${file} holds neither wait output with "items" nor an items array`);
  if (typeof saved?.canvas === "string" && saved.canvas !== canvas) {
    throw new Error(`${file} is wait output for canvas "${saved.canvas}", not "${canvas}"`);
  }
  const server = await ensureServer(root);
  process.stdout.write(JSON.stringify(ok(await api(server.port, "POST", "locate", { canvas, items }))) + "\n");
}

/**
 * @param {string} root
 * @param {string[]} args
 */
async function status(root, args) {
  positionals(args, 0);
  const server = await ensureServer(root);
  /** @type {import("./protocol.js").StatusResponse} */
  const s = ok(await api(server.port, "GET", "status"));
  const lines = [`Server: ${s.url} (pid ${s.pid})`, `Root: ${s.root}`, `Waiting: ${s.waiting}`];
  if (s.canvases.length === 0) {
    lines.push("Canvases: none");
  } else {
    lines.push("Canvases:");
    for (const c of s.canvases) lines.push(`  ${c.name}  "${c.title}"  held ${c.held}, tabs ${c.tabs}  ${s.url}/c/${c.name}`);
  }
  console.log(lines.join("\n"));
}

/**
 * Does not start a server: there is nothing to stop.
 * @param {string} root
 * @param {string[]} args
 */
async function stop(root, args) {
  positionals(args, 0);
  const server = await findServer(root);
  if (!server) {
    console.log("No sketchboard server is running.");
    return;
  }
  ok(await api(server.port, "POST", "stop"));
  for (let i = 0; i < 100 && (await findServer(root)); i++) await sleep(50);
  console.log(`Stopped the server at ${server.url} (pid ${server.pid}).`);
}

/**
 * @param {string} root
 * @param {string[]} args
 */
async function shot(root, args) {
  const [canvas, board] = positionals(args, 2);
  checkCanvas(canvas);
  const boardErr = boardNameError(board);
  if (boardErr) throw new Error(boardErr);
  const browser = findBrowser();
  if (!browser) throw new Error("no browser found: install Google Chrome, Chromium, Microsoft Edge, or Firefox, or put one on PATH");
  const server = await ensureServer(root);
  /** @type {import("./protocol.js").CanvasIndex} */
  const index = ok(await api(server.port, "GET", `canvas/${canvas}`));
  const rect = index.boards[board];
  if (!rect) throw new Error(`board "${board}" is not in ${indexFile(root, canvas)}`);
  // Without the file the server answers 404, and the browser would save that page as the PNG.
  if (!rootFile(root, [canvas, board])) throw new Error(`board file ${path.join(root, canvas, board)} does not exist`);
  const out = path.join(root, STATE_DIR, "shots", canvas, `${path.parse(board).name}.png`);
  const url = `${server.url}/design/${canvas}/${encodeURIComponent(board)}?raw=1`;
  await takeShot(browser, url, Math.round(rect.w), Math.round(rect.h), out);
  console.log(out);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`sketchboard: ${err.message}`);
  if (err instanceof UsageError) console.error(USAGE);
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
