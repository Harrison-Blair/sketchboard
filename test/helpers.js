import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const CLI = fileURLToPath(new URL("../bin/sketchboard.js", import.meta.url));

/**
 * A sketchboard root for one test: `<tmp>/sketchboard-test-XXXX/home`, as a
 * real path (macOS links /var to /private/var). The parent folder holds files
 * that must stay outside the root; cleanup() deletes it.
 */
export function makeHome() {
  const parent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "sketchboard-test-")));
  return path.join(parent, "home");
}

/**
 * Runs the CLI with SKETCHBOARD_HOME set to `home`, from the OS temp folder.
 * @param {string} home
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function cli(home, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: os.tmpdir(),
      env: { ...process.env, SKETCHBOARD_HOME: home, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * @param {string} root
 * @returns {import("../src/protocol.js").ServerState}
 */
export function readState(root) {
  return JSON.parse(readFileSync(path.join(root, ".state", "server.json"), "utf8"));
}

/**
 * Sends an HTTP request. Headers are sent as given, so tests can forge Host and Origin.
 * @param {number} port
 * @param {string} method
 * @param {string} urlPath
 * @param {{ body?: unknown, headers?: Record<string, string> }} [opts]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, text: string, json: () => any }>}
 */
export function http(port, method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    /** @type {Record<string, string | number>} */
    const headers = { ...opts.headers };
    if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * Opens an event stream and collects parsed `data:` events.
 * @param {number} port
 * @param {string} canvas
 */
export async function openEvents(port, canvas) {
  /** @type {any[]} */
  const events = [];
  /** @type {import("node:http").ClientRequest} */
  let req;
  await new Promise((resolve, reject) => {
    req = request({ host: "127.0.0.1", port, path: `/__sketchboard/api/events?canvas=${canvas}` }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`events returned ${res.statusCode}`));
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let at;
        while ((at = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
          else if (block.startsWith(": connected")) resolve(undefined);
        }
      });
      res.on("error", () => {});
    });
    req.on("error", reject);
    req.end();
  });
  return {
    events,
    close() {
      req.destroy();
    },
  };
}

/**
 * Polls `fn` until it returns a truthy value or the time runs out.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

/** @param {number} pid */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * Stops the server for `root` if one runs, then deletes the test folder that holds `root`.
 * @param {string} root
 */
export async function cleanup(root) {
  let pid;
  try {
    pid = readState(root).pid;
  } catch {
    // No server state.
  }
  await cli(root, ["stop"]);
  if (pid !== undefined && alive(pid)) {
    try {
      process.kill(pid);
    } catch {
      // Exited meanwhile.
    }
  }
  rmSync(path.dirname(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
