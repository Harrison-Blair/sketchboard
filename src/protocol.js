// Shared shapes and constants for the server, the CLI, and the browser UI.
// This file must stay importable in a browser: no Node imports, plain JSON
// shapes only. GET /__sketchboard/protocol.js serves the package
// src/protocol.js; UI modules import it as `./protocol.js`.
// tsconfig.browser.json maps ui/ and src/ together with rootDirs to match the served layout.
// docs/PROTOCOL.md lists the same endpoints.

export const DEFAULT_PORT = 4870;
export const HOST = "127.0.0.1";
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_WAIT_TIMEOUT_S = 540;
// SSE comment line interval. It keeps the browser from dropping an idle
// stream, and a failed write tells the server that a tab is gone.
export const SSE_KEEPALIVE_MS = 15 * 1000;

export const DESIGN_DIR = "design";
export const SYSTEM_DIR = "system";
export const STATE_DIR = ".canvas";
export const SERVER_FILE = "server.json";
export const INDEX_FILE = "canvas.json";

// Tool-owned URLs. Every other path is a shell page or a file under design/.
export const TOOL_PREFIX = "/__sketchboard/";
export const API_PREFIX = "/__sketchboard/api/";

// ---------------------------------------------------------------------------
// design/<canvas>/canvas.json (v1)

/**
 * @typedef {{ x: number, y: number, w: number, h: number, title: string }} BoardRect
 * @typedef {{ kind: "title", x: number, y: number, text: string }} TitleNote
 * @typedef {{ kind: "sticky", x: number, y: number, w: number, text: string }} StickyNote
 * @typedef {TitleNote | StickyNote} CanvasNote
 * @typedef {{ boards: string[], aspects?: string[] }} CompareGroup
 */

/**
 * `boards` is keyed by board file name. Board files sit next to canvas.json.
 * @typedef {object} CanvasIndex
 * @property {1} v
 * @property {string} title
 * @property {Record<string, BoardRect>} boards
 * @property {string[]} order
 * @property {Record<string, CanvasNote>} notes
 * @property {Record<string, CompareGroup>} compare
 */

// ---------------------------------------------------------------------------
// Feedback items. Coordinates are CSS px in the board document (page
// coordinates, scroll included).

/**
 * @typedef {{ kind: "element", board: string, selector: string, tag: string, text: string, note: string }} ElementItem
 *
 * `selector` is the closest element that contains the whole selection.
 * @typedef {{ kind: "text", board: string, selector: string, text: string, note: string }} TextItem
 *
 * `selector`, `tag`, and `text` describe the element under the pin.
 * @typedef {{ kind: "pin", board: string, x: number, y: number, selector: string, tag: string, text: string, note: string }} PinItem
 *
 * x/y/w/h is the bounding box of the drawn circle.
 * @typedef {{ kind: "circle", board: string, x: number, y: number, w: number, h: number, note: string }} CircleItem
 *
 * `applied: true`: the server replaced oldText in the file. `applied: false`:
 * oldText did not occur exactly once, so the file is unchanged and the agent
 * must make the change.
 * @typedef {{ kind: "edit", board: string, selector: string, oldText: string, newText: string, applied: boolean, note?: string }} EditItem
 *
 * @typedef {{ kind: "pick", compare: string, board: string, note?: string }} PickItem
 *
 * Take `aspect` from `board`.
 * @typedef {{ kind: "mix", compare: string, aspect: string, board: string, note?: string }} MixItem
 *
 * @typedef {{ kind: "message", text: string }} MessageItem
 *
 * @typedef {ElementItem | TextItem | PinItem | CircleItem | EditItem | PickItem | MixItem | MessageItem} FeedbackItem
 * @typedef {FeedbackItem["kind"]} FeedbackKind
 */

/**
 * stdout of `sketchboard wait`. `canvas` is null only when no canvas was
 * given and the wait timed out.
 * @typedef {{ canvas: string | null, items: FeedbackItem[], timedOut?: true }} WaitOutput
 */

// ---------------------------------------------------------------------------
// design/.canvas/server.json. The server writes it at start and deletes it at
// exit. The CLI reads it to find the server, then confirms with GET status.

/**
 * `root` is the absolute path of the directory that holds design/.
 * @typedef {{ v: 1, pid: number, port: number, url: string, root: string, startedAt: string }} ServerState
 */

// ---------------------------------------------------------------------------
// HTTP API. All endpoints are on http://127.0.0.1:<port>. JSON bodies use
// Content-Type: application/json. Errors return a non-2xx status with
// ApiError. `:canvas` is a folder name under design/.
//
// CLI note: fetch (undici) has a 300 s default headers timeout, which is
// shorter than the default wait timeout. Use node:http for `wait`.

/**
 * @typedef {{ error: string }} ApiError
 *
 * `held`: feedback held for this canvas and not yet read by `wait`.
 * `tabs`: connected browser tabs (open event streams) for this canvas.
 * @typedef {{ name: string, title: string, held: number, tabs: number }} CanvasSummary
 *
 * @typedef {{ canvas: string }} OpenRequest
 * @typedef {{ url: string, created: boolean }} OpenResponse
 *
 * @typedef {{ canvases: CanvasSummary[] }} CanvasListResponse
 *
 * `message` is the free-text composer message. The server stores it as a
 * MessageItem after `items`.
 * @typedef {{ canvas: string, items: FeedbackItem[], message?: string }} SendRequest
 * @typedef {{ held: number }} SendResponse
 *
 * @typedef {{ canvas: string, board: string, selector: string, oldText: string, newText: string }} EditRequest
 * The browser adds `item` to its Unsent queue. It reaches `wait` on Send.
 * @typedef {{ item: EditItem }} EditResponse
 *
 * `set`: notes to add or replace, by id. `remove`: note ids to delete.
 * @typedef {{ set?: Record<string, CanvasNote>, remove?: string[] }} NotesRequest
 * @typedef {{ notes: Record<string, CanvasNote> }} NotesResponse
 *
 * `waiting`: number of `wait` requests in progress.
 * @typedef {{ url: string, root: string, pid: number, canvases: CanvasSummary[], waiting: number }} StatusResponse
 *
 * @typedef {{ stopping: true }} StopResponse
 */

/**
 * Server-sent events on GET events. Each message is `data: <JSON>\n\n`.
 * An open stream counts as a connected tab for the idle-stop rule.
 * - board: a board file changed; reload that board's frame only.
 * - index: canvas.json changed; re-render the layout from `index`.
 * - system: a file under design/system/ changed; reload every frame.
 * @typedef {{ type: "board", canvas: string, board: string }
 *   | { type: "index", canvas: string, index: CanvasIndex }
 *   | { type: "system" }} ServerEvent
 */

/** @typedef {{ method: "GET" | "POST", path: string }} Endpoint */

/** @satisfies {Record<string, Endpoint>} */
export const ENDPOINTS = /** @type {const} */ ({
  // Shell page that lists canvases. Response: text/html.
  home: { method: "GET", path: "/" },
  // Shell page for one canvas. This is the URL `open` prints. Response: text/html.
  shell: { method: "GET", path: "/c/:canvas" },
  // The package src/protocol.js; UI modules import it as `./protocol.js`.
  // Matched before `asset`.
  protocol: { method: "GET", path: "/__sketchboard/protocol.js" },
  // Shell and overlay JS and CSS from the package ui/ folder.
  asset: { method: "GET", path: "/__sketchboard/:file" },
  // Any file under design/ except design/.canvas/. An .html file gets the
  // overlay <script> injected; `?raw=1` skips the injection (used by `shot`).
  // Boards sit at /design/<canvas>/<board>, so ../system/tokens.css works.
  file: { method: "GET", path: "/design/*" },
  // Create design/<canvas>/ and an empty canvas.json if missing.
  // OpenRequest -> OpenResponse.
  open: { method: "POST", path: "/__sketchboard/api/open" },
  // -> CanvasListResponse.
  canvases: { method: "GET", path: "/__sketchboard/api/canvases" },
  // -> CanvasIndex.
  index: { method: "GET", path: "/__sketchboard/api/canvas/:canvas" },
  // Merge note changes into canvas.json and keep every other key.
  // NotesRequest -> NotesResponse.
  notes: { method: "POST", path: "/__sketchboard/api/canvas/:canvas/notes" },
  // Server-sent event stream of ServerEvent. Query: ?canvas=<name>.
  events: { method: "GET", path: "/__sketchboard/api/events" },
  // Hold a batch of feedback for `wait`. SendRequest -> SendResponse.
  send: { method: "POST", path: "/__sketchboard/api/send" },
  // Hybrid text edit. EditRequest -> EditResponse.
  edit: { method: "POST", path: "/__sketchboard/api/edit" },
  // Long poll. Query: ?canvas=<name>&timeout=<s>. Without canvas, returns the
  // first canvas with held feedback. Returns at once if feedback is held,
  // else when Send arrives, else at timeout. -> WaitOutput.
  wait: { method: "GET", path: "/__sketchboard/api/wait" },
  // -> StatusResponse.
  status: { method: "GET", path: "/__sketchboard/api/status" },
  // Reply, then close all streams, delete server.json, and exit. -> StopResponse.
  stop: { method: "POST", path: "/__sketchboard/api/stop" },
});

/**
 * @param {string} title
 * @returns {CanvasIndex}
 */
export function emptyIndex(title) {
  return { v: 1, title, boards: {}, order: [], notes: {}, compare: {} };
}
