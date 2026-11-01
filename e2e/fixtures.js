// Test fixtures that drive the real CLI against a temporary sketchboard root.
// SKETCHBOARD_HOME points every CLI call (and the server it starts) at that
// root, so the tests never touch the real ~/.agents/sketchboard.
import { test as base, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/sketchboard.js", import.meta.url));

/**
 * @param {string} title
 * @param {string} body
 */
export function boardHtml(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>body { font-family: sans-serif; margin: 24px; } button { padding: 8px 16px; }</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export class Project {
  /** @param {string} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.root = "";
    this.started = false;
  }

  get dir() {
    return path.join(this.root, this.canvas);
  }

  /** @param {Record<string, string | object>} files */
  async create(files) {
    this.root = await mkdtemp(path.join(os.tmpdir(), "sketchboard-e2e-"));
    await mkdir(this.dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await this.write(name, content);
  }

  /** @param {string} name @param {string | object} content */
  async write(name, content) {
    await writeFile(path.join(this.dir, name), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }

  /** @param {string} name */
  async read(name) {
    return readFile(path.join(this.dir, name), "utf8");
  }

  async index() {
    return JSON.parse(await this.read("canvas.json"));
  }

  /** @param {string[]} args */
  async cli(...args) {
    if (!this.root) throw new Error("create() must run before the CLI, so SKETCHBOARD_HOME is set");
    const env = { ...process.env, SKETCHBOARD_HOME: this.root };
    const { stdout } = await run(process.execPath, [BIN, ...args], { cwd: os.tmpdir(), env, timeout: 30_000 });
    return stdout;
  }

  /** Runs `open` and returns the URL it prints. */
  async open() {
    const stdout = await this.cli("open", this.canvas);
    this.started = true;
    const url = stdout.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\S*/)?.[0];
    if (!url) throw new Error(`open printed no URL: ${stdout}`);
    return url;
  }

  /** Runs `wait` with a short timeout and returns the parsed feedback. */
  async wait() {
    return JSON.parse(await this.cli("wait", this.canvas, "--timeout", "5"));
  }

  async dispose() {
    if (!this.root) return;
    if (this.started) await this.cli("stop").catch(() => {});
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export const test = base.extend({
  /** @type {Project} */
  project: async ({}, use) => {
    const project = new Project("e2e");
    await use(project);
    await project.dispose();
  },
});

export { expect };

/** Two side-by-side boards that fit the test viewport at 100 % zoom. */
export const TWO_BOARDS = {
  v: 1,
  title: "E2E canvas",
  boards: {
    "a.html": { x: 0, y: 0, w: 480, h: 360, title: "Alpha" },
    "b.html": { x: 520, y: 0, w: 480, h: 360, title: "Beta" },
  },
  order: ["a.html", "b.html"],
  notes: {},
  compare: {},
};

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} board
 */
export function boardFrame(page, board) {
  return page.frameLocator(`.board[data-board="${board}"] iframe`);
}

/**
 * The Frame object of a canvas board, for evaluate().
 * @param {import("@playwright/test").Page} page
 * @param {string} board
 */
export async function boardFrameHandle(page, board) {
  const handle = await page.locator(`.board[data-board="${board}"] iframe`).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no frame for ${board}`);
  return frame;
}

const TOOL_LABELS = { none: "Interact", element: "Element", text: "Text", pin: "Pin", circle: "Circle", edit: "Edit text" };

/**
 * Chooses a tool, then waits until each board's overlay has the mode, so the
 * next click inside a board cannot race the mode message.
 * @param {import("@playwright/test").Page} page
 * @param {keyof typeof TOOL_LABELS} mode
 * @param {string[]} boards
 */
export async function useTool(page, mode, boards) {
  await page.getByRole("button", { name: TOOL_LABELS[mode], exact: true }).click();
  await waitForMode(page, mode, boards);
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {keyof typeof TOOL_LABELS} mode
 * @param {string[]} boards
 */
export async function waitForMode(page, mode, boards) {
  for (const board of boards) {
    const html = boardFrame(page, board).locator("html");
    if (mode === "none") await expect(html).not.toHaveAttribute("data-sketchboard-mode");
    else await expect(html).toHaveAttribute("data-sketchboard-mode", mode);
  }
}
