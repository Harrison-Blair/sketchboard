import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { INDEX_FILE, SERVER_FILE, STATE_DIR, SYSTEM_DIR } from "./protocol.js";

/** @typedef {import("./protocol.js").CanvasIndex} CanvasIndex */

/**
 * The root folder that holds every canvas: ~/.agents/sketchboard/, or
 * SKETCHBOARD_HOME when set (tests use it).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function sketchRoot(env = process.env) {
  return env.SKETCHBOARD_HOME ? path.resolve(env.SKETCHBOARD_HOME) : path.join(os.homedir(), ".agents", "sketchboard");
}

/** @param {string} root */
export function stateDir(root) {
  return path.join(root, STATE_DIR);
}

/** @param {string} root */
export function serverFile(root) {
  return path.join(stateDir(root), SERVER_FILE);
}

/**
 * @param {string} root
 * @param {string} canvas
 */
export function indexFile(root, canvas) {
  return path.join(root, canvas, INDEX_FILE);
}

/** @param {string} root */
export function ensureStateDir(root) {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Returns an error message, or null when the name is a valid canvas name.
 * Names are folder names in the root folder, so they must be portable and URL-safe.
 * @param {unknown} name
 */
export function canvasNameError(name) {
  if (typeof name !== "string" || name === "") return "canvas name is empty";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(name) || name.length > 100) {
    return `invalid canvas name "${name}": use letters, digits, ".", "_", or "-"; start with a letter or digit; no slashes`;
  }
  if (name.toLowerCase() === SYSTEM_DIR) return `"${SYSTEM_DIR}" is reserved for design systems`;
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is a reserved file name on Windows`;
  return null;
}

/**
 * Returns an error message, or null when the name is a plain file name.
 * @param {unknown} name
 */
export function boardNameError(name) {
  if (typeof name !== "string" || name === "") return "board name is empty";
  if (/[\\/\0]/.test(name) || name === "." || name === "..") return `invalid board name "${name}"`;
  return null;
}

/**
 * Reads canvas.json. Missing `notes`, `compare`, `order`, and `boards` read as empty.
 * Throws if the file is missing or is not valid JSON.
 * @param {string} root
 * @param {string} canvas
 * @returns {CanvasIndex}
 */
export function readIndex(root, canvas) {
  const raw = JSON.parse(readFileSync(indexFile(root, canvas), "utf8"));
  return {
    ...raw,
    boards: raw.boards ?? {},
    order: raw.order ?? [],
    notes: raw.notes ?? {},
    compare: raw.compare ?? {},
  };
}

/**
 * Real path of an existing file in the root folder, or null if it resolves
 * outside the root (symlinks included) or into <root>/.state/.
 * @param {string} root
 * @param {string[]} segments
 */
export function rootFile(root, segments) {
  let rootReal = null;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  const file = resolveInside(rootReal, segments);
  return file && insideRoot(file, rootReal) ? file : null;
}

/**
 * @param {string} real
 * @param {string} rootReal
 */
export function insideRoot(real, rootReal) {
  const rel = path.relative(rootReal, real);
  // Compare case-insensitively: macOS and Windows file systems usually are.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && rel.split(path.sep)[0].toLowerCase() !== STATE_DIR;
}

/**
 * Real path of an existing file inside `base`, or null if it escapes `base`
 * (symlinks included), is not a file, or does not exist.
 * @param {string} base
 * @param {string[]} segments
 */
export function resolveInside(base, segments) {
  try {
    const baseReal = realpathSync(base);
    const real = realpathSync(path.join(baseReal, ...segments));
    if (!real.startsWith(baseReal + path.sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
