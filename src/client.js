import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { API_PREFIX, HOST } from "./protocol.js";
import { ensureStateDir, serverFile, stateDir } from "./paths.js";

/** @typedef {import("./protocol.js").ServerState} ServerState */

const SERVER_ENTRY = fileURLToPath(new URL("./server.js", import.meta.url));
const START_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 15_000;

/**
 * Sends a JSON request to the server. `timeoutMs` 0 means no timeout.
 * @param {number} port
 * @param {"GET" | "POST"} method
 * @param {string} apiPath path after the API prefix, with query
 * @param {unknown} [body]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number, json: any }>}
 */
export function api(port, method, apiPath, body, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: HOST,
        port,
        method,
        path: API_PREFIX + apiPath,
        headers: data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * Returns the state of the running server for `root`, or null if none answers.
 * @param {string} root
 * @returns {Promise<ServerState | null>}
 */
export async function findServer(root) {
  /** @type {ServerState} */
  let state;
  try {
    state = JSON.parse(readFileSync(serverFile(root), "utf8"));
  } catch {
    return null;
  }
  try {
    const { status, json } = await api(state.port, "GET", "status", undefined, 2000);
    return status === 200 && json.pid === state.pid ? state : null;
  } catch {
    return null;
  }
}

/**
 * Returns the running server for `root`, and starts one if none answers.
 * A lock file keeps concurrent callers from starting two servers.
 * @param {string} root
 * @returns {Promise<ServerState>}
 */
export async function ensureServer(root) {
  const lock = path.join(stateDir(root), "start.lock");
  const deadline = Date.now() + START_TIMEOUT_MS + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    const running = await findServer(root);
    if (running) return running;
    ensureStateDir(root);
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      removeStaleLock(lock);
      await sleep(100);
      continue;
    }
    try {
      closeSync(fd);
      return (await findServer(root)) ?? (await startServer(root));
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // Already removed as stale by another caller.
      }
    }
  }
  throw new Error("timed out while waiting for another sketchboard command to start the server");
}

/** @param {string} lock */
function removeStaleLock(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
  } catch {
    // Gone already.
  }
}

/**
 * @param {string} root
 * @returns {Promise<ServerState>}
 */
async function startServer(root) {
  try {
    unlinkSync(serverFile(root));
  } catch {
    // No stale state file.
  }
  const logFile = path.join(stateDir(root), "server.log");
  const log = openSync(logFile, "a");
  const child = spawn(process.execPath, [SERVER_ENTRY, root], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();
  closeSync(log);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    await sleep(50);
    const state = await findServer(root);
    if (state && state.pid === child.pid) return state;
  }
  throw new Error(`the server did not start; see ${logFile}`);
}
