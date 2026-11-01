import { ENDPOINTS, emptyIndex } from "./protocol.js";

/**
 * @typedef {import("./protocol.js").CanvasIndex} CanvasIndex
 * @typedef {import("./protocol.js").CanvasNote} CanvasNote
 * @typedef {import("./protocol.js").BoardRect} BoardRect
 * @typedef {import("./protocol.js").FeedbackItem} FeedbackItem
 * @typedef {import("./protocol.js").ServerEvent} ServerEvent
 * @typedef {import("./protocol.js").EditResponse} EditResponse
 * @typedef {import("./protocol.js").NotesResponse} NotesResponse
 * @typedef {import("./protocol.js").SendRequest} SendRequest
 * @typedef {import("./protocol.js").CanvasListResponse} CanvasListResponse
 * @typedef {import("./overlay.js").Mode} Mode
 * @typedef {import("./overlay.js").Capture} Capture
 * @typedef {import("./overlay.js").Point} Point
 * @typedef {import("./overlay.js").BoardMessage} BoardMessage
 * @typedef {import("./overlay.js").ShellMessage} ShellMessage
 *
 * `key` marks a compare choice; a new choice with the same key replaces it.
 * @typedef {{ id: string, item: FeedbackItem, key?: string }} Unsent
 * @typedef {{ name: string, el: HTMLElement, frame: HTMLIFrameElement, title: HTMLElement, width: HTMLSelectElement, preset: number }} Board
 * @typedef {{ frame: HTMLIFrameElement, board: string, compare: boolean }} FrameRef
 */

const WIDTHS = [["Phone", 390], ["Tablet", 820], ["Desktop", 1280]];
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const STRIP_PX = 30;
const NARROW_STRIP_PX = 240;
/** Below this zoom the name strip is taller than a usual gap between boards. */
const TINY_SCALE = 0.3;
const HINTS = /** @type {Record<Mode, string>} */ ({
  none: "Interact with the boards, or choose a tool to point at something.",
  element: "Click an element on a board. Press Escape to stop.",
  text: "Select text on a board. Press Escape to stop.",
  pin: "Click a spot on a board to drop a pin. Press Escape to stop.",
  circle: "Drag a box on a board. Press Escape to stop.",
  edit: "Click text on a board to edit it. Enter saves, Escape cancels.",
});
const KIND_LABELS = /** @type {Record<FeedbackItem["kind"], string>} */ ({
  element: "Element", text: "Text", pin: "Pin", circle: "Circle", edit: "Edit", pick: "Pick", mix: "Mix", message: "Message",
});

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const viewport = $("viewport");
const world = $("world");
const notePop = /** @type {HTMLFormElement} */ ($("note-pop"));
const noteText = /** @type {HTMLTextAreaElement} */ ($("note-text"));
const message = /** @type {HTMLTextAreaElement} */ ($("message"));
const sendButton = /** @type {HTMLButtonElement} */ ($("send"));
const toolButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll("button[data-mode]")]);

let canvas = "";
/** @type {CanvasIndex} */
let index = emptyIndex("");
const view = { x: 40, y: 40, scale: 1 };
/** @type {Mode} */
let mode = "none";
/** @type {Map<string, Board>} */
const boards = new Map();
/** @type {Map<string, HTMLElement>} */
const noteEls = new Map();
/** @type {Map<string, HTMLIFrameElement>} */
const compareFrames = new Map();
/** @type {Unsent[]} */
let unsent = [];
let unsentSeq = 0;
/** @type {{ board: string, capture: Capture, frame: HTMLIFrameElement } | null} */
let pending = null;
/** @type {string | null} */
let openCompare = null;
let compareSignature = "";
/** @type {string | null} */
let draggingNote = null;
let sending = false;

// ---------------------------------------------------------------------------
// Server API

/**
 * @param {string} path
 * @param {Record<string, string>} [params]
 */
function apiUrl(path, params = {}) {
  return path.replace(/:(\w+)/g, (_, key) => encodeURIComponent(params[key] ?? ""));
}

/** @param {Response} response */
async function parse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}

/** @param {string} url */
async function getJson(url) {
  return parse(await fetch(url));
}

/**
 * @param {string} url
 * @param {unknown} body
 */
async function postJson(url, body) {
  return parse(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Page chrome

/** @param {(string | Node)[]} parts */
function showBanner(...parts) {
  const banner = $("banner");
  banner.replaceChildren(...parts);
  banner.hidden = false;
}

function hideBanner() {
  $("banner").hidden = true;
}

/** @param {string} text */
function code(text) {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
}

/** @param {string} text */
function hint(text) {
  $("hint").textContent = text;
}

/** @param {string} text @param {number} [max] */
function quote(text, max = 80) {
  return `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
}

/** @param {string} name */
function boardTitle(name) {
  return index.boards[name]?.title || name;
}

/** @param {string} name */
function boardUrl(name) {
  return `/design/${encodeURIComponent(canvas)}/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Home page

async function startHome() {
  $("home").hidden = false;
  $("conn").hidden = true;
  try {
    const { canvases } = /** @type {CanvasListResponse} */ (await getJson(apiUrl(ENDPOINTS.canvases.path)));
    const list = $("canvas-list");
    for (const summary of canvases) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = `/c/${encodeURIComponent(summary.name)}`;
      link.textContent = summary.title || summary.name;
      li.append(link);
      if (summary.title && summary.title !== summary.name) li.append(" ", code(summary.name));
      list.append(li);
    }
    $("home-empty").hidden = canvases.length > 0;
  } catch (error) {
    showBanner(`Could not reach the sketchboard server: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Frames and the overlay

/**
 * @param {HTMLIFrameElement} frame
 * @param {ShellMessage} data
 */
function postTo(frame, data) {
  frame.contentWindow?.postMessage(data, location.origin);
}

/**
 * Sends the tool mode and the canvas's board names. A board frame turns a
 * click on a link to one of those boards into a `link` message. Compare frames
 * get no names, so their links behave like any other link.
 * @param {HTMLIFrameElement} frame
 * @param {boolean} compare
 */
function postMode(frame, compare) {
  postTo(frame, { sketchboard: 1, type: "mode", mode: compare ? "none" : mode, boards: compare ? [] : Object.keys(index.boards) });
}

/** @param {MessageEventSource | null} source @returns {FrameRef | null} */
function findFrame(source) {
  for (const b of boards.values()) if (b.frame.contentWindow === source) return { frame: b.frame, board: b.name, compare: false };
  for (const [board, frame] of compareFrames) if (frame.contentWindow === source) return { frame, board, compare: true };
  return null;
}

/**
 * Maps a point in a frame's viewport to a point in the canvas viewport.
 * @param {HTMLIFrameElement} frame
 * @param {Point} point
 * @returns {Point}
 */
function framePoint(frame, point) {
  const r = frame.getBoundingClientRect();
  const scale = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
  const v = viewport.getBoundingClientRect();
  return { x: r.left + point.x * scale - v.left, y: r.top + point.y * scale - v.top };
}

/**
 * True when the frame's document was loaded from its board's URL. The
 * navigation entry keeps that URL when the board changes its own address
 * with history.pushState. False after a link to another page, before the
 * first load, and on another origin, where the frame cannot be read.
 * @param {HTMLIFrameElement} frame
 * @param {string} board
 */
function showsBoard(frame, board) {
  try {
    const entry = frame.contentWindow?.performance.getEntriesByType("navigation")[0];
    return !!entry && new URL(entry.name).pathname === boardPath(board);
  } catch {
    return false;
  }
}

/** @param {string} board */
function boardPath(board) {
  return new URL(boardUrl(board), location.href).pathname;
}

/**
 * location.reload() keeps the frame's scroll position; a new src would not.
 * A board that changed its own address with pushState is loaded again from
 * its file's URL instead. A frame that is not on its board is skipped:
 * keepOnBoard sends it back when its page loads, and that load gets the
 * current board. A frame that keepOnBoard gave up on is tried again.
 * @param {HTMLIFrameElement} frame
 * @param {string} board
 */
function reloadFrame(frame, board) {
  const guard = guards.get(frame);
  if (guard?.stuck) {
    setStuck(frame, guard, false);
    guard.backs = [];
    sendBack(frame, board);
  } else if (showsBoard(frame, board)) {
    const win = frame.contentWindow;
    if (win?.location.pathname === boardPath(board)) win.location.reload();
    else sendBack(frame, board);
  }
}

/**
 * Brings a frame back to its board. Location.replace, which other origins
 * also allow, replaces the frame's history entry, so Back still leaves the
 * canvas. A new src would add an entry.
 * @param {HTMLIFrameElement} frame
 * @param {string} board
 */
function sendBack(frame, board) {
  const url = new URL(boardUrl(board), location.href).href;
  try {
    frame.contentWindow?.location.replace(url);
  } catch {
    frame.src = url;
  }
}

/** A board that leaves by itself this often within GUARD_MS is left alone. */
const GUARD_BACKS = 3;
const GUARD_MS = 60000;
const LEAVING_ATTR = "data-sketchboard-leaving";

/**
 * `backs` holds the times of returns after the board left by itself.
 * @typedef {{ board: string, backs: number[], stuck: boolean }} Guard
 * @type {WeakMap<HTMLIFrameElement, Guard>}
 */
const guards = new WeakMap();

/**
 * Sends the frame back each time it loads a page other than its board. This
 * covers pages without the overlay, such as a missing file, a form result or
 * another site. A board that leaves by itself, for example to a sign-up
 * page, would loop, so after GUARD_BACKS such returns the frame stays where
 * it is and the board shows why. A save of the board tries again.
 * @param {HTMLIFrameElement} frame
 * @param {string} board
 */
function keepOnBoard(frame, board) {
  /** @type {Guard} */
  const guard = { board, backs: [], stuck: false };
  guards.set(frame, guard);
  frame.addEventListener("load", () => {
    // The overlay sets this on the frame when a person's click or form submit
    // leaves the page. It sets the attribute directly because a message posted
    // at that moment can arrive after the next page replaced the board, and
    // then cannot be traced to this frame.
    const userLeft = frame.hasAttribute(LEAVING_ATTR);
    frame.removeAttribute(LEAVING_ATTR);
    if (showsBoard(frame, board)) {
      if (guard.stuck) setStuck(frame, guard, false);
      return;
    }
    if (guard.stuck) return;
    if (!userLeft) {
      const now = performance.now();
      guard.backs = guard.backs.filter((t) => now - t < GUARD_MS);
      if (guard.backs.length >= GUARD_BACKS) {
        setStuck(frame, guard, true);
        return;
      }
      guard.backs.push(now);
    }
    sendBack(frame, board);
  });
}

/**
 * @param {HTMLIFrameElement} frame
 * @param {Guard} guard
 * @param {boolean} stuck
 */
function setStuck(frame, guard, stuck) {
  guard.stuck = stuck;
  frame.parentElement?.querySelector(".stuck")?.remove();
  if (!stuck) return;
  const note = document.createElement("p");
  note.className = "stuck";
  note.setAttribute("role", "alert");
  note.textContent = `${boardTitle(guard.board)} keeps navigating away when it loads. Save the file to try again.`;
  frame.before(note);
}

/** @param {string} name */
function reloadBoard(name) {
  const board = boards.get(name);
  if (board) reloadFrame(board.frame, name);
  const compareFrame = compareFrames.get(name);
  if (compareFrame) reloadFrame(compareFrame, name);
}

function reloadAll() {
  for (const name of boards.keys()) reloadBoard(name);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const data = /** @type {BoardMessage} */ (event.data);
  if (data?.sketchboard !== 1) return;
  const from = findFrame(event.source);
  if (!from) return;
  // Messages from a page other than the board are dropped. keepOnBoard sends
  // that frame back when the page loads.
  if (!showsBoard(from.frame, from.board)) return;
  if (data.type === "ready") postMode(from.frame, from.compare);
  else if (data.type === "key") onKey(data.key, data.down);
  else if (from.compare) return;
  else if (data.type === "capture") openNote(from, data.capture, data.anchor);
  else if (data.type === "link") showBoard(data.board);
  else if (data.type === "edit") submitEdit(from.board, data.selector, data.oldText, data.newText, data.plain, data.newHtml, data.src, data.ver);
  else if (data.type === "zoom") {
    const p = framePoint(from.frame, data);
    zoomAt(p.x, p.y, Math.exp(-data.deltaY * 0.002));
  }
});

// ---------------------------------------------------------------------------
// Pointing tools and the note field

/** @param {Mode} next */
function setMode(next) {
  if (pending) cancelNote();
  mode = next;
  for (const button of toolButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === next));
  for (const board of boards.values()) postMode(board.frame, false);
  viewport.dataset.mode = mode;
  hint(HINTS[mode]);
}

/** @param {Capture} capture */
function describeCapture(capture) {
  if (capture.kind === "element") return `<${capture.tag}>`;
  if (capture.kind === "text") return quote(capture.text, 40);
  if (capture.kind === "pin") return `a pin on <${capture.tag}>`;
  return "a circled area";
}

/**
 * @param {FrameRef} from
 * @param {Capture} capture
 * @param {Point} anchor
 */
function openNote(from, capture, anchor) {
  if (pending && pending.frame !== from.frame) postTo(pending.frame, { sketchboard: 1, type: "clear" });
  pending = { board: from.board, capture, frame: from.frame };
  $("note-label").textContent = `Note on ${describeCapture(capture)} in ${boardTitle(from.board)}`;
  noteText.value = "";
  notePop.hidden = false;
  const p = framePoint(from.frame, anchor);
  const left = Math.max(8, Math.min(p.x + 12, viewport.clientWidth - notePop.offsetWidth - 8));
  const top = Math.max(8, Math.min(p.y + 12, viewport.clientHeight - notePop.offsetHeight - 8));
  notePop.style.left = `${left}px`;
  notePop.style.top = `${top}px`;
  noteText.focus();
}

function closeNote() {
  if (pending) postTo(pending.frame, { sketchboard: 1, type: "clear" });
  pending = null;
  notePop.hidden = true;
}

function cancelNote() {
  closeNote();
  viewport.focus({ preventScroll: true });
}

notePop.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pending) return;
  const item = /** @type {FeedbackItem} */ ({ ...pending.capture, board: pending.board, note: noteText.value.trim() });
  closeNote();
  addUnsent(item);
  hint(`Added to Unsent. ${HINTS[mode]}`);
  viewport.focus({ preventScroll: true });
});

noteText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    notePop.requestSubmit();
  }
});

$("note-cancel").addEventListener("click", cancelNote);

for (const button of toolButtons) {
  button.addEventListener("click", () => setMode(/** @type {Mode} */ (button.dataset.mode)));
}

/**
 * @param {string} board
 * @param {string} selector
 * @param {string} oldText
 * @param {string} newText
 * @param {boolean} plain False when the element's text spans other markup,
 *   or the edit added or removed elements. The text is then not written that
 *   way in the file, and the server could match it in another element.
 * @param {string} newHtml The element's content as the page shows it after
 *   the edit. Only an edit that is not applied carries it, so the agent can
 *   see the markup the person kept.
 * @param {number | null} src The element's position in the board file, or
 *   null when a script made or copied the element.
 * @param {string | undefined} ver The version of the file that the page shows.
 */
async function submitEdit(board, selector, oldText, newText, plain, newHtml, src, ver) {
  const doc = boards.get(board)?.frame.contentDocument ?? null;
  const el = doc?.querySelector(selector) ?? null;
  const queue = src === null
    ? `A script made or copied this element, so its place in ${board} is not known. The edit is queued for the agent.`
    : !plain
      ? "The edit involves markup inside the element, so it is queued for the agent."
      : doc && overlapsUnsaved(doc, el)
        ? `An earlier edit here is not in ${board} yet. This edit is queued for the agent.`
        : "";
  /** @param {string} reason */
  const queueEdit = (reason) => {
    addUnsent({ kind: "edit", board, selector, oldText, newText, applied: false, newHtml, src, ver });
    markUnsaved(doc, el);
    hint(reason);
  };
  if (queue) {
    queueEdit(queue);
    return;
  }
  hint("Saving the edit…");
  try {
    if (!(await sourceHolds(board, selector, oldText))) {
      queueEdit(`The text is not written at this element in ${board}, so the edit is queued for the agent.`);
      return;
    }
    const { item } = /** @type {EditResponse} */ (await postJson(ENDPOINTS.edit.path, { canvas, board, selector, oldText, newText, src, ver }));
    addUnsent(item.applied ? { src, ver, ...item } : { src, ver, ...item, newHtml });
    if (!item.applied) markUnsaved(doc, el);
    hint(item.applied
      ? `Edit saved to ${board}.`
      : `${quote(oldText, 40)} does not match exactly one whole text in ${board}. The edit is queued for the agent.`);
  } catch (error) {
    markUnsaved(doc, el);
    hint(`The edit failed: ${errorText(error)}`);
  }
}

/**
 * Whether the board file, as it is now, has the element at the selector with
 * oldText as its whole text. Text that a script put there, for example from a
 * <template> or an attribute, is not in the file at that element, and the
 * server could change the same text elsewhere. The file is parsed without
 * running its scripts.
 * @param {string} board
 * @param {string} selector
 * @param {string} oldText
 */
async function sourceHolds(board, selector, oldText) {
  const response = await fetch(boardUrl(board), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const source = new DOMParser().parseFromString(await response.text(), "text/html");
  return source.querySelector(selector)?.textContent?.trim() === oldText;
}

/**
 * Elements whose text in the board differs from the file because an edit was
 * not applied. A later edit on one of them, or on an element inside or around
 * one, would send text that the file does not hold there, and the server
 * could change a matching text elsewhere. Such an edit is queued for the agent
 * instead. The entries belong to one document, so a reload of the board from
 * its file, after which the page matches the file again, clears them.
 * @type {WeakMap<Document, Element[]>}
 */
const unsaved = new WeakMap();

/** @param {Document | null} doc @param {Element | null} el */
function markUnsaved(doc, el) {
  if (!doc || !el) return;
  unsaved.set(doc, [...(unsaved.get(doc) ?? []), el]);
}

/**
 * True when the element is, contains, or is inside an element with an edit
 * that is not in the file. An element that cannot be found counts as
 * overlapping when the page has any such edit.
 * @param {Document} doc
 * @param {Element | null} el
 */
function overlapsUnsaved(doc, el) {
  const list = unsaved.get(doc) ?? [];
  if (list.length === 0) return false;
  if (!el) return true;
  return list.some((other) => other.contains(el) || el.contains(other));
}

// ---------------------------------------------------------------------------
// Unsent queue and composer

function storageKey() {
  return `sketchboard:unsent:${canvas}`;
}

function saveUnsent() {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(unsent));
  } catch {}
}

function loadUnsent() {
  try {
    unsent = JSON.parse(sessionStorage.getItem(storageKey()) ?? "[]");
  } catch {
    unsent = [];
  }
}

/** @param {FeedbackItem} item @param {string} [key] */
function addUnsent(item, key) {
  if (key) unsent = unsent.filter((u) => u.key !== key);
  unsent.push({ id: `${Date.now()}-${unsentSeq++}`, item, key });
  unsentChanged();
}

/** @param {(u: Unsent) => boolean} drop */
function removeUnsent(drop) {
  unsent = unsent.filter((u) => !drop(u));
  unsentChanged();
}

function unsentChanged() {
  saveUnsent();
  renderUnsent();
  syncCompareChoices();
}

/** @param {FeedbackItem} item */
function describeItem(item) {
  switch (item.kind) {
    case "element": return `<${item.tag}> ${quote(item.text)}`;
    case "text": return quote(item.text);
    case "pin": return `Pin at ${item.x}, ${item.y} on <${item.tag}> ${quote(item.text, 40)}`;
    case "circle": return `Box ${item.w} × ${item.h} at ${item.x}, ${item.y}`;
    case "edit": return `${quote(item.oldText, 40)} → ${quote(item.newText, 40)}`;
    case "pick": return `Pick ${boardTitle(item.board)} in ${item.compare}`;
    case "mix": return `Take ${item.aspect} from ${boardTitle(item.board)} in ${item.compare}`;
    case "message": return item.text;
  }
}

function renderUnsent() {
  $("unsent-label").textContent = `Unsent (${unsent.length})`;
  $("unsent-empty").hidden = unsent.length > 0;
  const rows = unsent.map((u, i) => {
    const { item } = u;
    const li = document.createElement("li");
    li.className = "unsent-item";
    const head = document.createElement("div");
    head.className = "unsent-head";
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = KIND_LABELS[item.kind];
    head.append(kind);
    if ("board" in item && item.kind !== "pick" && item.kind !== "mix") {
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = boardTitle(item.board);
      head.append(where);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    if (item.kind === "edit" && item.applied) {
      // There is no undo: removing the note leaves the change in the file.
      remove.setAttribute("aria-label", "Remove note (the file keeps the change)");
      remove.title = "Remove note (the file keeps the change)";
    } else remove.setAttribute("aria-label", `Remove item ${i + 1}: ${KIND_LABELS[item.kind]}`);
    remove.addEventListener("click", () => {
      const next = /** @type {HTMLElement | null} */ (li.nextElementSibling?.querySelector(".remove") ?? li.previousElementSibling?.querySelector(".remove") ?? null);
      removeUnsent((other) => other.id === u.id);
      (next ?? message).focus();
    });
    head.append(remove);
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = describeItem(item);
    li.append(head, detail);
    if ("note" in item && item.note) {
      const note = document.createElement("div");
      note.className = "note-text";
      note.textContent = item.note;
      li.append(note);
    }
    if (item.kind === "edit") {
      const status = document.createElement("div");
      status.className = item.applied ? "status applied" : "status queued";
      status.textContent = item.applied ? "In the file" : "Not applied: queued for the agent";
      li.append(status);
    }
    return li;
  });
  $("unsent-list").replaceChildren(...rows);
  updateSendButton();
}

function updateSendButton() {
  sendButton.disabled = sending || (unsent.length === 0 && message.value.trim() === "");
}

message.addEventListener("input", updateSendButton);

$("skip").addEventListener("click", (event) => {
  event.preventDefault();
  message.focus();
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = message.value.trim();
  if (sending || (unsent.length === 0 && !text)) return;
  sending = true;
  updateSendButton();
  const status = $("send-status");
  status.textContent = "Sending…";
  const sent = unsent;
  /** @type {SendRequest} */
  const body = { canvas, items: sent.map((u) => u.item) };
  if (text) body.message = text;
  try {
    await postJson(ENDPOINTS.send.path, body);
    const ids = new Set(sent.map((u) => u.id));
    removeUnsent((u) => ids.has(u.id));
    message.value = "";
    const count = `${sent.length} item${sent.length === 1 ? "" : "s"}`;
    status.textContent = `Sent ${count}${text ? " and a message" : ""} to the agent.`;
  } catch (error) {
    status.textContent = `Send failed: ${errorText(error)}. Your items are still in Unsent.`;
  } finally {
    sending = false;
    updateSendButton();
  }
});

// ---------------------------------------------------------------------------
// Pan and zoom

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  world.style.setProperty("--inv", String(1 / view.scale));
  $("zoom-level").textContent = `${Math.round(view.scale * 100)}%`;
  for (const board of boards.values()) fitStrip(board);
}

/**
 * Hides the width select when the board is too narrow on screen to show it
 * beside the name, and the whole strip when the zoom is so small that the
 * strip would cover the board or note above it.
 * @param {Board} board
 */
function fitStrip(board) {
  board.el.classList.toggle("narrow", boardWidth(board) * view.scale < NARROW_STRIP_PX);
  board.el.classList.toggle("tiny", view.scale < TINY_SCALE);
}

/**
 * @param {number} x viewport px
 * @param {number} y viewport px
 * @param {number} factor
 */
function zoomAt(x, y, factor) {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const k = scale / view.scale;
  view.x = x - (x - view.x) * k;
  view.y = y - (y - view.y) * k;
  view.scale = scale;
  applyView();
}

/** @param {number} factor */
function zoomCentre(factor) {
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
}

/** @param {Board} board */
function boardWidth(board) {
  return board.preset || index.boards[board.name].w;
}

function fitAll() {
  const rects = [];
  for (const board of boards.values()) {
    const r = index.boards[board.name];
    rects.push({ x: r.x, y: r.y, w: boardWidth(board), h: r.h });
  }
  for (const [id, el] of noteEls) {
    const note = index.notes[id];
    rects.push({ x: note.x, y: note.y, w: el.offsetWidth, h: el.offsetHeight });
  }
  if (rects.length === 0) {
    Object.assign(view, { x: 40, y: 40, scale: 1 });
    return applyView();
  }
  fitRects(rects);
}

/**
 * Zooms (to at most 100 %) and pans so the rects fill the view, centred.
 * @param {{ x: number, y: number, w: number, h: number }[]} rects
 */
function fitRects(rects) {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const pad = 32;
  const width = Math.max(1, viewport.clientWidth - 2 * pad);
  const height = Math.max(1, viewport.clientHeight - 2 * pad - STRIP_PX);
  const scale = Math.min(1, Math.max(MIN_SCALE, Math.min(width / (maxX - minX), height / (maxY - minY))));
  view.scale = scale;
  view.x = pad + (width - (maxX - minX) * scale) / 2 - minX * scale;
  view.y = pad + STRIP_PX + (height - (maxY - minY) * scale) / 2 - minY * scale;
  applyView();
}

/**
 * Brings a board into view after a link to it, and marks it briefly.
 * @param {string} name
 */
function showBoard(name) {
  const board = boards.get(name);
  if (!board) return;
  const r = index.boards[name];
  fitRects([{ x: r.x, y: r.y, w: boardWidth(board), h: r.h }]);
  board.el.classList.remove("flash");
  void board.el.offsetWidth;
  board.el.classList.add("flash");
}

/** @param {number} x @param {number} y */
function toWorld(x, y) {
  return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale };
}

let spaceDown = false;
/** @type {{ x: number, y: number, vx: number, vy: number, id: number } | null} */
let pan = null;

/** @param {boolean} down */
function setSpace(down) {
  spaceDown = down;
  viewport.classList.toggle("space", down);
}

/**
 * @param {"Escape" | " "} key
 * @param {boolean} down
 */
function onKey(key, down) {
  if (key === " ") setSpace(down);
  else if (pending) cancelNote();
  else if (openCompare) closeCompare();
  else if (mode !== "none") setMode("none");
}

/** @param {EventTarget | null} target */
function isPanSurface(target) {
  if (target === viewport || target === world || target === $("shield")) return true;
  return target instanceof Element && target.closest(".strip") !== null && target.closest("select, button, label") === null;
}

viewport.addEventListener("pointerdown", (event) => {
  if ((event.button !== 0 && event.button !== 1) || !isPanSurface(event.target)) return;
  event.preventDefault();
  viewport.focus({ preventScroll: true });
  pan = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, id: event.pointerId };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("dragging");
});

viewport.addEventListener("pointermove", (event) => {
  if (!pan || event.pointerId !== pan.id) return;
  view.x = pan.vx + event.clientX - pan.x;
  view.y = pan.vy + event.clientY - pan.y;
  applyView();
});

/** @param {PointerEvent} event */
function endPan(event) {
  if (!pan || event.pointerId !== pan.id) return;
  pan = null;
  viewport.classList.remove("dragging");
}
viewport.addEventListener("pointerup", endPan);
viewport.addEventListener("pointercancel", endPan);

viewport.addEventListener("wheel", (event) => {
  if (event.target instanceof Element && event.target.closest("textarea") && !event.ctrlKey) return;
  event.preventDefault();
  const v = viewport.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : 1;
  if (event.ctrlKey || event.metaKey) zoomAt(event.clientX - v.left, event.clientY - v.top, Math.exp(-event.deltaY * unit * 0.002));
  else {
    view.x -= event.deltaX * unit;
    view.y -= event.deltaY * unit;
    applyView();
  }
}, { passive: false });

viewport.addEventListener("keydown", (event) => {
  if (event.target !== viewport) return;
  const step = event.shiftKey ? 200 : 60;
  const moves = /** @type {Record<string, [number, number]>} */ ({ ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] });
  if (event.key in moves) {
    event.preventDefault();
    view.x += moves[event.key][0];
    view.y += moves[event.key][1];
    applyView();
  } else if (event.key === "+" || event.key === "=") zoomCentre(1.25);
  else if (event.key === "-") zoomCentre(0.8);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") onKey("Escape", true);
  else if (event.key === " " && (event.target === document.body || event.target === viewport)) {
    event.preventDefault();
    if (!event.repeat) setSpace(true);
  }
});
document.addEventListener("keyup", (event) => {
  if (event.key === " " && spaceDown) setSpace(false);
});
window.addEventListener("blur", () => setSpace(false));

$("zoom-in").addEventListener("click", () => zoomCentre(1.25));
$("zoom-out").addEventListener("click", () => zoomCentre(0.8));
$("fit-all").addEventListener("click", fitAll);

// ---------------------------------------------------------------------------
// Boards

function orderedBoards() {
  const names = index.order.filter((name) => name in index.boards);
  for (const name of Object.keys(index.boards)) if (!names.includes(name)) names.push(name);
  return names;
}

/** @param {string} name @returns {Board} */
function createBoard(name) {
  const el = document.createElement("div");
  el.className = "board";
  el.dataset.board = name;
  const strip = document.createElement("div");
  strip.className = "strip";
  const title = document.createElement("span");
  title.className = "board-name";
  const label = document.createElement("label");
  label.className = "width";
  label.append("Width ");
  const width = document.createElement("select");
  width.append(new Option("", "0"), ...WIDTHS.map(([text, px]) => new Option(`${text} ${px}`, String(px))));
  label.append(width);
  strip.append(title, label);
  const frame = document.createElement("iframe");
  frame.src = boardUrl(name);
  keepOnBoard(frame, name);
  el.append(strip, frame);
  world.append(el);
  /** @type {Board} */
  const board = { name, el, frame, title, width, preset: 0 };
  width.addEventListener("change", () => {
    board.preset = Number(width.value);
    sizeBoard(board);
  });
  return board;
}

/** @param {Board} board */
function sizeBoard(board) {
  const r = index.boards[board.name];
  const w = boardWidth(board);
  board.el.style.width = `${w}px`;
  board.frame.style.width = `${w}px`;
  board.frame.style.height = `${r.h}px`;
  fitStrip(board);
}

function renderBoards() {
  for (const [name, board] of boards) {
    if (name in index.boards) continue;
    board.el.remove();
    boards.delete(name);
  }
  const names = orderedBoards();
  for (const name of names) {
    let board = boards.get(name);
    if (!board) {
      board = createBoard(name);
      boards.set(name, board);
    }
    const r = index.boards[name];
    board.el.style.left = `${r.x}px`;
    board.el.style.top = `${r.y}px`;
    board.title.textContent = r.title || name;
    board.title.title = r.title || name;
    board.el.title = r.title || name;
    board.frame.title = `Board: ${r.title || name}`;
    board.width.options[0].text = `Board ${r.w}`;
    board.width.setAttribute("aria-label", `Width of ${r.title || name}`);
    sizeBoard(board);
  }
  $("empty").hidden = names.length > 0;
  for (const board of boards.values()) postMode(board.frame, false);
}

// ---------------------------------------------------------------------------
// Titles and stickies

/** @param {string} id @param {CanvasNote} note */
async function saveNote(id, note) {
  index.notes[id] = note;
  await notesRequest({ set: { [id]: note } });
}

/** @param {string} id */
async function deleteNote(id) {
  delete index.notes[id];
  renderNotes();
  await notesRequest({ remove: [id] });
}

/** @param {import("./protocol.js").NotesRequest} body */
async function notesRequest(body) {
  try {
    const { notes } = /** @type {NotesResponse} */ (await postJson(apiUrl(ENDPOINTS.notes.path, { canvas }), body));
    index.notes = notes;
    renderNotes();
  } catch (error) {
    hint(`Could not save the note: ${errorText(error)}`);
  }
}

/** @param {"sticky" | "title"} kind */
function newNoteId(kind) {
  const prefix = kind === "sticky" ? "s" : "t";
  let n = 1;
  while (`${prefix}${n}` in index.notes) n++;
  return `${prefix}${n}`;
}

/** @param {string} id @param {HTMLElement} el */
function placeNote(id, el) {
  const note = index.notes[id];
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  if (note.kind === "sticky") el.style.width = `${note.w}px`;
}

/** @param {string} id @param {CanvasNote["kind"]} kind */
function createNote(id, kind) {
  const el = document.createElement("div");
  el.className = `note ${kind}`;
  el.dataset.note = id;
  el.dataset.kind = kind;
  const name = kind === "sticky" ? "sticky" : "title";
  const bar = document.createElement("div");
  bar.className = "note-bar";
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "grip";
  grip.setAttribute("aria-label", `Move ${name}. Drag it, or use the arrow keys.`);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.textContent = "×";
  del.setAttribute("aria-label", `Delete ${name}`);
  bar.append(grip, del);
  const field = kind === "sticky" ? document.createElement("textarea") : document.createElement("input");
  field.className = "note-field";
  field.setAttribute("aria-label", kind === "sticky" ? "Sticky text" : "Title text");
  el.append(bar, field);

  field.addEventListener("change", () => {
    const note = index.notes[id];
    if (note) saveNote(id, { ...note, text: field.value });
  });
  del.addEventListener("click", () => {
    deleteNote(id);
    viewport.focus({ preventScroll: true });
  });

  /** @type {{ px: number, py: number, x: number, y: number, moved: boolean, pointer: number } | null} */
  let drag = null;
  grip.addEventListener("pointerdown", (event) => {
    const note = index.notes[id];
    if (!note || event.button !== 0) return;
    event.preventDefault();
    grip.focus();
    grip.setPointerCapture(event.pointerId);
    drag = { px: event.clientX, py: event.clientY, x: note.x, y: note.y, moved: false, pointer: event.pointerId };
    draggingNote = id;
    viewport.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (event) => {
    const note = index.notes[id];
    if (!drag || !note || event.pointerId !== drag.pointer) return;
    note.x = Math.round(drag.x + (event.clientX - drag.px) / view.scale);
    note.y = Math.round(drag.y + (event.clientY - drag.py) / view.scale);
    drag.moved = true;
    placeNote(id, el);
  });
  /** @param {PointerEvent} event */
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const moved = drag.moved;
    drag = null;
    draggingNote = null;
    viewport.classList.remove("dragging");
    const note = index.notes[id];
    if (moved && note) saveNote(id, note);
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let keySave;
  grip.addEventListener("keydown", (event) => {
    const note = index.notes[id];
    const step = event.shiftKey ? 50 : 10;
    const moves = /** @type {Record<string, [number, number]>} */ ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] });
    if (!note || !(event.key in moves)) return;
    event.preventDefault();
    note.x += moves[event.key][0];
    note.y += moves[event.key][1];
    placeNote(id, el);
    clearTimeout(keySave);
    keySave = setTimeout(() => saveNote(id, note), 400);
  });

  world.append(el);
  return el;
}

function renderNotes() {
  for (const [id, el] of noteEls) {
    const note = index.notes[id];
    if (note && note.kind === el.dataset.kind) continue;
    el.remove();
    noteEls.delete(id);
  }
  for (const id of Object.keys(index.notes)) {
    const note = index.notes[id];
    let el = noteEls.get(id);
    if (!el) {
      el = createNote(id, note.kind);
      noteEls.set(id, el);
    }
    if (draggingNote !== id) placeNote(id, el);
    const field = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el.querySelector(".note-field"));
    if (document.activeElement !== field) field.value = note.text;
  }
}

/** @param {"sticky" | "title"} kind */
function addNote(kind) {
  const centre = toWorld(viewport.clientWidth / 2, viewport.clientHeight / 2);
  const id = newNoteId(kind);
  const x = Math.round(centre.x - (kind === "sticky" ? 120 : 80));
  const y = Math.round(centre.y - 40);
  /** @type {CanvasNote} */
  const note = kind === "sticky" ? { kind, x, y, w: 240, text: "" } : { kind, x, y, text: "Title" };
  index.notes[id] = note;
  renderNotes();
  const field = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (noteEls.get(id)?.querySelector(".note-field") ?? null);
  field?.focus();
  field?.select();
  saveNote(id, note);
}

$("add-sticky").addEventListener("click", () => addNote("sticky"));
$("add-title").addEventListener("click", () => addNote("title"));

// ---------------------------------------------------------------------------
// Compare

function renderCompareList() {
  const names = Object.keys(index.compare);
  $("compare-sect").hidden = names.length === 0;
  $("compare-list").replaceChildren(...names.map((name) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.compare = name;
    button.textContent = `${name} (${index.compare[name].boards.length} boards)`;
    button.addEventListener("click", () => showCompare(name));
    li.append(button);
    return li;
  }));
}

/** @param {string} group */
function compareBoards(group) {
  return index.compare[group].boards.filter((name) => name in index.boards);
}

/** @param {string} key */
function chosenBoard(key) {
  const found = unsent.find((u) => u.key === key);
  return found && "board" in found.item ? found.item.board : "";
}

/**
 * @param {string} legend
 * @param {string} key
 * @param {string[]} names
 * @param {(board: string) => FeedbackItem} make
 */
function choiceRow(legend, key, names, make) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "choice-row";
  const caption = document.createElement("legend");
  caption.textContent = legend;
  fieldset.append(caption);
  for (const [value, text] of [...names.map((name) => [name, boardTitle(name)]), ["", "None"]]) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = key;
    input.value = value;
    input.dataset.key = key;
    input.checked = chosenBoard(key) === value;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      if (value) addUnsent(make(value), key);
      else removeUnsent((u) => u.key === key);
    });
    label.append(input, ` ${text}`);
    fieldset.append(label);
  }
  return fieldset;
}

function syncCompareChoices() {
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ ($("compare-choices").querySelectorAll("input[type=radio]"))) {
    input.checked = chosenBoard(input.dataset.key ?? "") === input.value;
  }
}

/** @param {string} group */
function signature(group) {
  return JSON.stringify([index.compare[group], compareBoards(group).map((name) => index.boards[name])]);
}

/** @param {string} group */
function showCompare(group) {
  setMode("none");
  openCompare = group;
  compareSignature = signature(group);
  const names = compareBoards(group);
  $("compare-title").textContent = `Compare: ${group}`;
  compareFrames.clear();
  const figures = names.map((name) => {
    const figure = document.createElement("figure");
    const caption = document.createElement("figcaption");
    caption.textContent = boardTitle(name);
    const box = document.createElement("div");
    box.className = "compare-box";
    const frame = document.createElement("iframe");
    frame.src = boardUrl(name);
    keepOnBoard(frame, name);
    frame.title = `Compare board: ${boardTitle(name)}`;
    box.append(frame);
    figure.append(caption, box);
    compareFrames.set(name, frame);
    return figure;
  });
  $("compare-frames").replaceChildren(...figures);
  const rows = [choiceRow("Pick", `pick:${group}`, names, (board) => ({ kind: "pick", compare: group, board }))];
  for (const aspect of index.compare[group].aspects ?? []) {
    rows.push(choiceRow(`${aspect} from`, `mix:${group}:${aspect}`, names, (board) => ({ kind: "mix", compare: group, aspect, board })));
  }
  $("compare-choices").replaceChildren(...rows);
  $("compare-view").hidden = false;
  viewport.hidden = true;
  document.querySelector(".toolbar")?.setAttribute("hidden", "");
  $("hint").hidden = true;
  layoutCompare();
  $("compare-close").focus();
}

function layoutCompare() {
  if (!openCompare) return;
  const names = compareBoards(openCompare);
  if (names.length === 0) return;
  const { w, h } = index.boards[names[0]];
  const gap = 16;
  const avail = $("compare-frames").clientWidth - gap * (names.length - 1);
  const scale = Math.min(1, avail / (w * names.length));
  for (const frame of compareFrames.values()) {
    const box = /** @type {HTMLElement} */ (frame.parentElement);
    box.style.width = `${w * scale}px`;
    box.style.height = `${h * scale}px`;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.style.transform = `scale(${scale})`;
  }
}

function closeCompare() {
  const group = openCompare;
  openCompare = null;
  compareFrames.clear();
  $("compare-frames").replaceChildren();
  $("compare-choices").replaceChildren();
  $("compare-view").hidden = true;
  viewport.hidden = false;
  document.querySelector(".toolbar")?.removeAttribute("hidden");
  $("hint").hidden = false;
  const button = /** @type {HTMLElement | null} */ ($("compare-list").querySelector(`[data-compare="${CSS.escape(group ?? "")}"]`));
  (button ?? viewport).focus();
}

$("compare-close").addEventListener("click", closeCompare);
new ResizeObserver(layoutCompare).observe($("compare-frames"));

// ---------------------------------------------------------------------------
// Canvas page

function renderAll() {
  const title = index.title || canvas;
  $("canvas-title").textContent = title;
  document.title = `${title} · sketchboard`;
  renderBoards();
  renderNotes();
  renderCompareList();
  if (openCompare) {
    if (!(openCompare in index.compare)) closeCompare();
    else if (signature(openCompare) !== compareSignature) showCompare(openCompare);
  }
}

async function loadIndex() {
  index = /** @type {CanvasIndex} */ (await getJson(apiUrl(ENDPOINTS.index.path, { canvas })));
  renderAll();
}

/** @param {ServerEvent} event */
function onServerEvent(event) {
  if (event.type === "system") return reloadAll();
  if (event.canvas !== canvas) return;
  if (event.type === "board") reloadBoard(event.board);
  else {
    index = event.index;
    renderAll();
  }
}

let lost = false;

function connect() {
  const conn = $("conn");
  const events = new EventSource(`${ENDPOINTS.events.path}?canvas=${encodeURIComponent(canvas)}`);
  events.addEventListener("open", () => {
    conn.textContent = "Live";
    conn.dataset.state = "live";
    if (!lost) return;
    lost = false;
    hideBanner();
    loadIndex().then(reloadAll, () => {});
  });
  events.addEventListener("message", (event) => onServerEvent(JSON.parse(event.data)));
  events.addEventListener("error", () => {
    lost = true;
    conn.textContent = "Offline";
    conn.dataset.state = "offline";
    showBanner("Server stopped. Run ", code(`sketchboard open ${canvas}`), " to restart it. Retrying…");
    if (events.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  });
}

/** @param {string} name */
async function startCanvas(name) {
  canvas = name;
  $("app").hidden = false;
  loadUnsent();
  unsentSeq = unsent.length;
  renderUnsent();
  setMode("none");
  applyView();
  try {
    await loadIndex();
    fitAll();
    connect();
  } catch (error) {
    showBanner(`Could not load canvas ${canvas}: ${errorText(error)}. Run `, code(`sketchboard open ${canvas}`), ".");
  }
}

const match = location.pathname.match(/^\/c\/([^/]+)\/?$/);
if (match) startCanvas(decodeURIComponent(match[1]));
else startHome();
