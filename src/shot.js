import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** @typedef {{ kind: "chromium" | "firefox", path: string }} Browser */

const CHROMIUM_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "chrome", "msedge"];
const FIREFOX_NAMES = ["firefox"];
const SHOT_TIMEOUT_MS = Number(process.env.SKETCHBOARD_SHOT_TIMEOUT_MS) || 60_000;

/**
 * Finds Chrome, Chromium, or Edge, else Firefox. Returns null if none exists.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {Browser | null}
 */
export function findBrowser(env = process.env, platform = process.platform) {
  for (const [kind, names, installs] of /** @type {const} */ ([
    ["chromium", CHROMIUM_NAMES, chromiumInstalls(env, platform)],
    ["firefox", FIREFOX_NAMES, firefoxInstalls(env, platform)],
  ])) {
    const found = names.map((n) => onPath(n, env, platform)).find((p) => p !== null) ?? installs.find(isFile);
    if (found) return { kind, path: found };
  }
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 */
function chromiumInstalls(env, platform) {
  if (platform === "darwin") {
    return macApps(env, ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]);
  }
  if (platform === "win32") {
    return windowsDirs(env).flatMap((d) => [
      path.win32.join(d, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(d, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(d, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 */
function firefoxInstalls(env, platform) {
  if (platform === "darwin") return macApps(env, ["Firefox.app/Contents/MacOS/firefox"]);
  if (platform === "win32") return windowsDirs(env).map((d) => path.win32.join(d, "Mozilla Firefox", "firefox.exe"));
  return [];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} apps
 */
function macApps(env, apps) {
  const dirs = ["/Applications", ...(env.HOME ? [path.posix.join(env.HOME, "Applications")] : [])];
  return dirs.flatMap((d) => apps.map((a) => path.posix.join(d, a)));
}

/** @param {NodeJS.ProcessEnv} env */
function windowsDirs(env) {
  return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((d) => d !== undefined);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 */
function onPath(name, env, platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (env.PATH ?? "").split(p.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** @param {string} file */
function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Renders `url` at w×h to a PNG at `out` with a headless browser. Each run
 * uses a fresh temporary profile, so a running browser does not block it.
 * @param {Browser} browser
 * @param {string} url
 * @param {number} w
 * @param {number} h
 * @param {string} out
 */
export async function takeShot(browser, url, w, h, out) {
  mkdirSync(path.dirname(out), { recursive: true });
  rmSync(out, { force: true });
  let result = await attempt(browser, url, w, h, out, []);
  if (!existsSync(out) && browser.kind === "chromium" && process.platform === "linux") {
    // Some Linux hosts (e.g. Ubuntu 24.04 runners) block the Chromium sandbox.
    result = await attempt(browser, url, w, h, out, ["--no-sandbox"]);
  } else if (!existsSync(out) && browser.kind === "firefox") {
    // Headless Firefox sometimes crashes or hangs once; say so, so a real failure stays visible.
    process.stderr.write(`sketchboard: Firefox wrote no screenshot (${failure(result)}); retrying once\n`);
    result = await attempt(browser, url, w, h, out, []);
  }
  if (!existsSync(out)) {
    throw new Error(`${path.basename(browser.path)} did not write a screenshot (${failure(result)})\n${result.output.trim()}`);
  }
}

/** @param {{ code: number | null, timedOut: boolean }} result */
function failure(result) {
  return result.timedOut ? `timed out after ${SHOT_TIMEOUT_MS / 1000} s` : `exit ${result.code}`;
}

/**
 * One browser run with its own temporary profile, deleted afterwards.
 * @param {Browser} browser
 * @param {string} url
 * @param {number} w
 * @param {number} h
 * @param {string} out
 * @param {string[]} extra
 */
async function attempt(browser, url, w, h, out, extra) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sketchboard-shot-"));
  const args =
    browser.kind === "chromium"
      ? ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${profile}`, `--window-size=${w},${h}`, `--screenshot=${out}`, url]
      : ["--headless", "--no-remote", "--profile", profile, "--window-size", `${w},${h}`, "--screenshot", out, url];
  try {
    return await run(browser.path, [...extra, ...args]);
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      // On Windows a crash handler can still hold the profile; a written PNG must not fail because of it.
      process.stderr.write(`sketchboard: could not delete the temporary profile ${profile}: ${/** @type {Error} */ (err).message}\n`);
    }
  }
}

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, output: string, timedOut: boolean }>}
 */
function run(file, args) {
  return new Promise((resolve, reject) => {
    // Firefox's crash reporter outlives a crashed browser; keep it from starting.
    const env = { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" };
    // On POSIX the browser gets its own process group, so killTree reaches every child.
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, SHOT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // "exit", not "close": a leftover child process can hold the pipes open.
    child.on("exit", (code) => {
      clearTimeout(timer);
      // Stop children that outlive the browser (POSIX: the group still exists).
      if (process.platform !== "win32") killTree(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, output, timedOut });
    });
  });
}

/**
 * Kills a process and all its descendants.
 * @param {number | undefined} pid
 */
function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}
