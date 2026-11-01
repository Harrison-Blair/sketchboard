// Injected into every board HTML the server serves. It captures pointing
// targets and text edits and reports them to the shell page by postMessage.
// It does nothing when the board is not framed by a same-origin shell.

/**
 * @typedef {"none" | "element" | "text" | "pin" | "circle" | "edit"} Mode
 * @typedef {{ x: number, y: number }} Point
 *
 * A pointing target without `board` and `note`; the shell adds both.
 * @typedef {{ kind: "element", selector: string, tag: string, text: string }
 *   | { kind: "text", selector: string, text: string }
 *   | { kind: "pin", x: number, y: number, selector: string, tag: string, text: string }
 *   | { kind: "circle", x: number, y: number, w: number, h: number }} Capture
 *
 * Messages from a board to the shell. `anchor` is in board viewport px.
 * @typedef {{ sketchboard: 1, type: "ready" }
 *   | { sketchboard: 1, type: "capture", capture: Capture, anchor: Point }
 *   | { sketchboard: 1, type: "edit", selector: string, oldText: string, newText: string, plain: boolean, newHtml: string, src: number | null, ver: string | undefined, anchor: Point }
 *   | { sketchboard: 1, type: "key", key: "Escape" | " ", down: boolean }
 *   | { sketchboard: 1, type: "link", board: string }
 *   | { sketchboard: 1, type: "zoom", deltaY: number, x: number, y: number }} BoardMessage
 *
 * Messages from the shell to a board. `boards` lists the canvas's board file
 * names. `clear` removes the capture marks.
 * @typedef {{ sketchboard: 1, type: "mode", mode: Mode, boards: string[] }
 *   | { sketchboard: 1, type: "clear" }} ShellMessage
 */

const TEXT_LIMIT = 200;
/** A navigation that starts this soon after a person's input was started by that person. */
const INPUT_LEAVE_MS = 1000;
const MARK_ATTR = "data-sketchboard-mark";
const MODE_ATTR = "data-sketchboard-mode";
// The server adds these to a served board: each element's position in the
// file, and the version of the file.
const SRC_ATTR = "data-sb-src";
const VER_ATTR = "data-sb-ver";

/**
 * Returns a short CSS selector that matches only `el` in its document.
 * It prefers a unique id, then tag and class names, then :nth-of-type steps.
 * @param {Element} el
 * @returns {string}
 */
export function selectorFor(el) {
  const doc = el.ownerDocument;
  /** @param {string} selector */
  const unique = (selector) => doc.querySelectorAll(selector).length === 1;
  let rest = "";
  for (let node = el; ; ) {
    const tag = node.localName;
    if (tag === "html" || tag === "body") return rest ? `${tag} > ${rest}` : tag;
    const join = (/** @type {string} */ step) => (rest ? `${step} > ${rest}` : step);
    if (node.id && unique(`#${CSS.escape(node.id)}`)) return join(`#${CSS.escape(node.id)}`);
    const classes = [...node.classList].filter((name) => /^-?[_a-zA-Z][\w-]*$/.test(name)).slice(0, 2);
    const steps = [tag];
    for (let i = 1; i <= classes.length; i++) steps.push(tag + classes.slice(0, i).map((c) => `.${CSS.escape(c)}`).join(""));
    const found = steps.find((step) => unique(join(step)));
    if (found) return join(found);
    const parent = node.parentElement;
    if (!parent) return join(tag);
    const siblings = [...parent.children];
    let step = steps.find((s) => siblings.filter((child) => child.matches(s)).length === 1);
    if (!step) {
      const sameTag = siblings.filter((child) => child.localName === tag);
      step = `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    rest = join(step);
    if (unique(rest)) return rest;
    node = parent;
  }
}

/** @param {Element} el */
function textOf(el) {
  const raw = el instanceof HTMLElement ? el.innerText : el.textContent ?? "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

/** @param {Element} el */
function hasOwnText(el) {
  return [...el.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "");
}

/**
 * The element that an edit-mode click on el edits. An icon, an <svg> or an
 * <img>, has no text, so a click on it edits the element that it sits in.
 * @param {Element} el
 */
function editTarget(el) {
  const icon = el.closest("svg") ?? (el.localName === "img" ? el : null);
  const host = icon ? icon.parentElement : el;
  return host && hasOwnText(host) ? host : null;
}

/** @param {Element} el */
function isOwnMark(el) {
  return el.closest(`[${MARK_ATTR}]`) !== null;
}

function framedByShell() {
  if (window.parent === window) return false;
  try {
    return window.parent.location.origin === location.origin;
  } catch {
    return false;
  }
}

function start() {
  const shell = window.parent;
  // In a frame these would move the whole tab's history and could take the
  // person off the canvas, so a board's own calls do nothing.
  history.back = () => {};
  history.forward = () => {};
  history.go = () => {};
  /** @type {Mode} */
  let mode = "none";
  /** @type {string[]} */
  let boards = [];
  /** @type {HTMLElement[]} */
  let marks = [];
  /** @type {{ x: number, y: number, box: HTMLElement } | null} */
  let drawing = null;
  /** @type {{ el: HTMLElement, selector: string, oldText: string, text: string, plain: boolean, html: string, children: Element[], breaks: Range[], holders: Range[], sources: Range[], done: AbortController } | null} */
  let editing = null;

  const style = document.createElement("style");
  style.setAttribute(MARK_ATTR, "");
  style.textContent = `
[${MODE_ATTR}="element"] *, [${MODE_ATTR}="edit"] * { cursor: pointer !important; }
[${MODE_ATTR}="pin"] *, [${MODE_ATTR}="circle"] * { cursor: crosshair !important; }
[${MODE_ATTR}="circle"] * { user-select: none !important; }
[${MARK_ATTR}] { position: absolute; z-index: 2147483647; pointer-events: none; box-sizing: border-box; margin: 0; }
[${MARK_ATTR}="hover"] { position: fixed; outline: 2px solid #c2410c; background: rgb(194 65 12 / 0.08); }
[${MARK_ATTR}="box"] { outline: 2px solid #c2410c; background: rgb(194 65 12 / 0.12); }
[${MARK_ATTR}="pin"] { width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #c2410c; border: 2px solid #fff; }
[contenteditable][${MODE_ATTR}-editing] { outline: 2px solid #1d4ed8 !important; outline-offset: 2px; }
`;
  document.head.append(style);

  const hover = document.createElement("div");
  hover.setAttribute(MARK_ATTR, "hover");
  hover.hidden = true;
  document.documentElement.append(hover);

  /** @param {BoardMessage} message */
  const post = (message) => shell.postMessage(message, location.origin);

  /**
   * @param {"box" | "pin"} kind
   * @param {number} x
   * @param {number} y
   * @param {number} [w]
   * @param {number} [h]
   */
  const mark = (kind, x, y, w, h) => {
    const el = document.createElement("div");
    el.setAttribute(MARK_ATTR, kind);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (w !== undefined && h !== undefined) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    document.documentElement.append(el);
    marks.push(el);
    return el;
  };

  /** @param {Element} el */
  const markElement = (el) => {
    const r = el.getBoundingClientRect();
    mark("box", r.left + scrollX, r.top + scrollY, r.width, r.height);
  };

  const clearMarks = () => {
    for (const el of marks) el.remove();
    marks = [];
  };

  /** @param {Capture} capture @param {Point} anchor */
  const capture = (capture, anchor) => post({ sketchboard: 1, type: "capture", capture, anchor });

  /**
   * One range over each "\n" in the text of root, or in the part of that text
   * from one offset to another.
   * @param {Node} root
   */
  const newlineRanges = (root, from = 0, to = Infinity) => {
    /** @type {Range[]} */
    const ranges = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let at = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? "";
      for (let i = value.indexOf("\n"); i >= 0; i = value.indexOf("\n", i + 1)) {
        if (at + i < from || at + i >= to) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        ranges.push(range);
      }
      at += value.length;
    }
    return ranges;
  };

  /**
   * Whether one of the ranges is still over a "\n" and holds the character.
   * @param {Range[]} ranges
   * @param {Range} char
   */
  const covers = (ranges, char) => ranges.some((range) => range.toString() === "\n"
    && range.compareBoundaryPoints(Range.START_TO_START, char) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, char) >= 0);

  /** @param {boolean} save */
  const finishEdit = (save) => {
    if (!editing) return;
    const { el, selector, oldText, text, html, children, sources, holders, done } = editing;
    // Newlines that were in the text at the start are source formatting and
    // stay. Every other "\n", such as a pasted, dropped or redone line break
    // that Chromium wrote as a character, becomes a <br>.
    let added = 0;
    if (save) {
      const toEnd = document.createRange();
      for (const range of holders) {
        toEnd.setStart(range.endContainer, range.endOffset);
        toEnd.setEnd(el, el.childNodes.length);
        // Text typed at the caret goes in before the holder, inside the range.
        if (!range.toString().endsWith("\n") || toEnd.toString() !== "") continue;
        range.setStart(range.endContainer, range.endOffset - 1);
        range.deleteContents();
      }
      // A redo brings back the holder at the end untracked.
      if (el.textContent?.endsWith("\n") && !text.endsWith("\n")) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let last = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue) last = node;
        if (last?.nodeValue) last.nodeValue = last.nodeValue.slice(0, -1);
      }
      const found = newlineRanges(el).filter((char) => !covers(sources, char));
      added = found.length;
      for (const range of found.reverse()) {
        range.deleteContents();
        range.insertNode(document.createElement("br"));
      }
    }
    // An added "\n" is markup that newText cannot express.
    const leftover = added > 0;
    // Chromium leaves a <br> in an element whose text was all deleted, to
    // keep the line open. It is not part of the edit.
    if (save && !el.textContent?.trim()) {
      for (const br of el.querySelectorAll(":scope > br")) if (!children.includes(br)) br.remove();
    }
    // An edit that removed or added elements, such as a deleted icon or a
    // pasted line break, changed markup that newText cannot express.
    const sameChildren = children.length === el.children.length && children.every((child, i) => child === el.children[i]);
    const plain = editing.plain && sameChildren && !leftover;
    editing = null;
    done.abort();
    el.removeAttribute("contenteditable");
    el.removeAttribute(`${MODE_ATTR}-editing`);
    const newText = (el.textContent ?? "").trim();
    if (!save) {
      el.innerHTML = html;
      el.blur();
      return;
    }
    el.blur();
    // Chromium wraps each new line in a <div>. Inside a <p> the HTML parser
    // would move it out, so newHtml gives the lines joined by <br> instead.
    // A <br> at the end of a line before a <div> only holds that line open,
    // as in a blank line <div><br></div>, so it does not add a line.
    // When a paste splits a child block that was there at the start, Chromium
    // copies that block, its stamp included. The copy stays a block of the
    // same kind, and its stamp goes, because it is not in the file.
    const splitCopy = (/** @type {Node} */ node) => node instanceof Element && !children.includes(node)
      && children.some((child) => child.localName === node.localName && child.hasAttribute(SRC_ATTR) && child.getAttribute(SRC_ATTR) === node.getAttribute(SRC_ATTR));
    const splits = [...el.children].filter(splitCopy);
    for (const node of splits) node.removeAttribute(SRC_ATTR);
    const isNewBlock = (/** @type {Node} */ node) => (node instanceof HTMLDivElement || node instanceof HTMLParagraphElement) && !children.includes(node) && !splits.includes(node);
    if ([...el.childNodes].some(isNewBlock)) {
      /** @type {Node[][]} */
      const lines = [];
      /** @type {Node[]} */
      let run = [];
      const endLine = (/** @type {Node[]} */ line) => {
        if (line.at(-1) instanceof HTMLBRElement) line.pop();
        lines.push(line);
      };
      for (const node of [...el.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue === "") continue;
        if (!isNewBlock(node)) {
          run.push(node);
          continue;
        }
        if (run.length) endLine(run);
        run = [];
        endLine([...node.childNodes]);
      }
      if (run.length) lines.push(run);
      // A line that ends in a block needs no <br> to end it.
      const endsInBlock = (/** @type {Node[]} */ line) => {
        const last = line.at(-1);
        return last instanceof Element && !getComputedStyle(last).display.startsWith("inline");
      };
      el.replaceChildren(...lines.flatMap((line, i) => (i && !endsInBlock(lines[i - 1]) ? [document.createElement("br"), ...line] : line)));
    }
    const r = el.getBoundingClientRect();
    // The server marks each element from the file with its position there.
    // The marks are not part of the content.
    const content = /** @type {Element} */ (el.cloneNode(true));
    for (const child of content.querySelectorAll(`[${SRC_ATTR}]`)) child.removeAttribute(SRC_ATTR);
    // A script's cloneNode copies the mark too. When two elements share it,
    // the file position of the edited one is not known.
    const stamp = el.getAttribute(SRC_ATTR);
    // A <template> may be cloned many times; the stamp in its content names
    // the template's element, which is the place in the file.
    const stamped = `[${SRC_ATTR}="${CSS.escape(stamp ?? "")}"]`;
    const fromTemplate = [...document.querySelectorAll("template")].some((t) => t.content.querySelector(stamped));
    const src = stamp !== null && (fromTemplate || document.querySelectorAll(stamped).length === 1) ? Number(stamp) : null;
    const ver = document.querySelector(`[${VER_ATTR}]`)?.getAttribute(VER_ATTR) ?? undefined;
    if (newText !== oldText || !sameChildren) post({ sketchboard: 1, type: "edit", selector, oldText, newText, plain, newHtml: content.innerHTML, src, ver, anchor: { x: r.left, y: r.bottom } });
  };

  /** @param {Element} target */
  const startEdit = (target) => {
    if (!(target instanceof HTMLElement) || !hasOwnText(target)) return;
    const oldText = (target.textContent ?? "").trim();
    const done = new AbortController();
    // The edit is plain when the element has one run of text, directly inside
    // it. Text that spans other markup, such as <em> or a comment, is not
    // written that way in the file. Elements without text, such as an icon,
    // do not count.
    const texts = [];
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue?.trim()) texts.push(node);
    const plain = texts.length === 1 && texts[0].parentNode === target;
    editing = { el: target, selector: selectorFor(target), oldText, text: target.textContent ?? "", plain, html: target.innerHTML, children: [...target.children], breaks: [], holders: [], sources: newlineRanges(target), done };
    target.setAttribute("contenteditable", "plaintext-only");
    target.setAttribute(`${MODE_ATTR}-editing`, "");
    target.focus();
    const range = document.createRange();
    // A plain edit selects only its text, so typing does not delete an icon
    // beside it. Chromium deletes a selected <img> with the first keystroke.
    if (plain) {
      const node = texts[0];
      const value = node.nodeValue ?? "";
      range.setStart(node, value.length - value.trimStart().length);
      range.setEnd(node, value.trimEnd().length);
    }
    else range.selectNodeContents(target);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    target.addEventListener("blur", () => finishEdit(true), { signal: done.signal });
    // A plaintext-only element takes a pasted newline as "\n" in its text,
    // which shows as a space once the file is loaded again. The overlay
    // inserts the lines itself, with the same commands as typing so that undo
    // works, and finishEdit turns each new line into a <br>. A trailing newline
    // adds no line. Newlines already in the text are source formatting and
    // stay as they are.
    // In an inline element, a button or a table cell, insertParagraph adds a
    // "\n" character, not a block. At the end of the element it adds a second
    // "\n" after the caret to hold the new last line open. finishEdit turns
    // each added line break into a <br> and drops the holder if it is still
    // the last character. Live ranges follow both through later typing.
    /**
     * @param {Node | null | undefined} node
     * @param {number} offset
     * @param {-1 | 1} side
     */
    const charRange = (node, offset, side) => {
      if (node && node.nodeType !== Node.TEXT_NODE) {
        node = node.childNodes[side < 0 ? offset - 1 : offset];
        offset = side < 0 ? node?.nodeValue?.length ?? 0 : 0;
      }
      if (node?.nodeType === Node.TEXT_NODE && side < 0 && offset === 0 && node.previousSibling?.nodeType === Node.TEXT_NODE) {
        node = node.previousSibling;
        offset = node.nodeValue?.length ?? 0;
      }
      if (node?.nodeType !== Node.TEXT_NODE) return null;
      const at = side < 0 ? offset - 1 : offset;
      if (node.nodeValue?.[at] !== "\n") return null;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range;
    };
    const newLine = () => {
      const blocks = target.querySelectorAll("div, p").length;
      document.execCommand("insertParagraph");
      if (target.querySelectorAll("div, p").length > blocks || !editing) return;
      const { anchorNode, anchorOffset = 0 } = getSelection() ?? {};
      const added = charRange(anchorNode, anchorOffset, -1);
      if (added) editing.breaks.push(added);
      const holder = charRange(anchorNode, anchorOffset, 1);
      if (holder) editing.holders.push(holder);
    };
    // Undo collapses the ranges of the pasted breaks, and a redo would put the
    // "\n" characters back untracked. So there is no redo after such a paste.
    target.addEventListener("beforeinput", (event) => {
      if (event.inputType === "historyRedo" && (editing?.breaks.length || editing?.holders.length)) event.preventDefault();
    }, { signal: done.signal });
    // An undo puts a deleted source newline back as a new "\n" character,
    // and its source range stays collapsed. An undo goes back to an earlier
    // state of the text, so each state is kept with the places of its source
    // newlines. Undo searches earlier states and redo searches later states.
    // Chromium can replace text nodes on undo, so places are offsets.
    /** @param {Range} range */
    const offsetOf = (range) => {
      const before = document.createRange();
      before.setStart(target, 0);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString().length;
    };
    /** @type {{ text: string, sources: number[] }[]} */
    const states = [];
    let stateIndex = -1;
    const record = () => {
      if (!editing) return;
      states.splice(stateIndex + 1);
      states.push({ text: target.textContent ?? "", sources: editing.sources.filter((range) => range.toString() === "\n").map(offsetOf) });
      stateIndex = states.length - 1;
    };
    target.addEventListener("input", (event) => {
      if (!editing) return;
      const type = /** @type {InputEvent} */ (event).inputType;
      if (type === "historyUndo" || type === "historyRedo") {
        const direction = type === "historyUndo" ? -1 : 1;
        for (let i = stateIndex + direction; i >= 0 && i < states.length; i += direction) {
          if (states[i].text !== target.textContent) continue;
          stateIndex = i;
          editing.sources = states[i].sources.flatMap((at) => newlineRanges(target, at, at + 1));
          break;
        }
      } else record();
    }, { signal: done.signal });
    record();
    target.addEventListener("paste", (event) => {
      if (!event.isTrusted) return;
      const raw = event.clipboardData?.getData("text/plain") ?? "";
      if (!/[\r\n]/.test(raw)) return;
      event.preventDefault();
      // Setting the selection again ends the typing before the paste, so
      // Chromium does not undo that typing together with the paste.
      const selection = getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      raw.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").forEach((line, i) => {
        if (i) newLine();
        if (line || !i) document.execCommand("insertText", false, line);
      });
    }, { signal: done.signal });
  };

  /** @param {Mode} next */
  const setMode = (next) => {
    finishEdit(true);
    mode = next;
    hover.hidden = true;
    if (drawing) {
      drawing.box.remove();
      drawing = null;
    }
    if (mode === "none") document.documentElement.removeAttribute(MODE_ATTR);
    else document.documentElement.setAttribute(MODE_ATTR, mode);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== shell || event.origin !== location.origin) return;
    const data = /** @type {ShellMessage} */ (event.data);
    if (data?.sketchboard !== 1) return;
    if (data.type === "mode") {
      boards = data.boards;
      setMode(data.mode);
    }
    else if (data.type === "clear") {
      clearMarks();
      if (mode === "text") getSelection()?.removeAllRanges();
    }
  });

  /** @param {Event} event */
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const pointingAt = (/** @type {Event} */ event) => {
    const target = event.target;
    return target instanceof Element && !isOwnMark(target) ? target : null;
  };

  window.addEventListener("pointermove", (event) => {
    if (!event.isTrusted) return;
    if (drawing) {
      const x = Math.min(drawing.x, event.pageX);
      const y = Math.min(drawing.y, event.pageY);
      Object.assign(drawing.box.style, {
        left: `${x}px`, top: `${y}px`,
        width: `${Math.abs(event.pageX - drawing.x)}px`, height: `${Math.abs(event.pageY - drawing.y)}px`,
      });
      return;
    }
    const target = pointingAt(event);
    const show = !target ? null
      : mode === "element" || mode === "pin" ? target
        : mode === "edit" && !editing ? editTarget(target) : null;
    hover.hidden = !show;
    if (!show) return;
    const r = show.getBoundingClientRect();
    Object.assign(hover.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }, true);

  window.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    if (mode === "element" || mode === "pin") swallow(event);
    if (mode !== "circle" || event.button !== 0) return;
    swallow(event);
    drawing = { x: event.pageX, y: event.pageY, box: mark("box", event.pageX, event.pageY, 0, 0) };
  }, true);

  window.addEventListener("mousedown", (event) => {
    if (!event.isTrusted) return;
    if (mode === "element" || mode === "pin" || mode === "circle") event.preventDefault();
  }, true);

  window.addEventListener("pointerup", (event) => {
    if (!event.isTrusted) return;
    if (!drawing) return;
    const { x: x0, y: y0, box } = drawing;
    drawing = null;
    const x = Math.round(Math.min(x0, event.pageX));
    const y = Math.round(Math.min(y0, event.pageY));
    const w = Math.round(Math.abs(event.pageX - x0));
    const h = Math.round(Math.abs(event.pageY - y0));
    if (w < 4 || h < 4) {
      box.remove();
      marks = marks.filter((el) => el !== box);
      return;
    }
    capture({ kind: "circle", x, y, w, h }, { x: event.clientX, y: event.clientY });
  }, true);

  window.addEventListener("mouseup", (event) => {
    if (!event.isTrusted) return;
    if (mode !== "text") return;
    setTimeout(() => {
      const selection = getSelection();
      const text = selection?.toString().trim() ?? "";
      if (!selection || selection.isCollapsed || !text) return;
      const common = selection.getRangeAt(0).commonAncestorContainer;
      const el = common instanceof Element ? common : common.parentElement;
      if (!el) return;
      capture({ kind: "text", selector: selectorFor(el), text }, { x: event.clientX, y: event.clientY });
    });
  }, true);

  /**
   * The board file a link points to, if it is a board of this canvas.
   * @param {Event} event
   */
  const linkedBoard = (event) => {
    const link = event.target instanceof Element ? event.target.closest("a, area") : null;
    const href = link?.getAttribute("href") ?? link?.getAttribute("xlink:href");
    if (!href) return null;
    let url;
    try {
      url = new URL(href, document.baseURI);
    } catch {
      return null;
    }
    // The board's own file path. A board can change location with pushState.
    const own = new URL(performance.getEntriesByType("navigation")[0]?.name ?? location.href).pathname;
    const folder = own.slice(0, own.lastIndexOf("/") + 1);
    if (url.origin !== location.origin || !url.pathname.startsWith(folder)) return null;
    // A link within this board, such as "#features" or "#", keeps its own behavior.
    if (url.pathname === own || url.pathname === location.pathname) return null;
    const board = decodeURIComponent(url.pathname.slice(folder.length));
    return boards.includes(board) ? board : null;
  };

  /** @param {MouseEvent} event */
  const followBoardLink = (event) => {
    const board = linkedBoard(event);
    if (!board) return false;
    swallow(event);
    post({ sketchboard: 1, type: "link", board });
    return true;
  };

  window.addEventListener("auxclick", (event) => {
    if (event.isTrusted && mode === "none" && event.button === 1) followBoardLink(event);
  }, true);

  window.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    if (mode === "none") {
      followBoardLink(event);
      return;
    }
    swallow(event);
    if (editing && editing.el.contains(/** @type {Node} */ (event.target))) return;
    const target = pointingAt(event);
    if (!target) return;
    const anchor = { x: event.clientX, y: event.clientY };
    if (mode === "element") {
      clearMarks();
      markElement(target);
      capture({ kind: "element", selector: selectorFor(target), tag: target.localName, text: textOf(target) }, anchor);
    } else if (mode === "pin") {
      clearMarks();
      mark("pin", event.pageX, event.pageY);
      capture({
        kind: "pin", x: Math.round(event.pageX), y: Math.round(event.pageY),
        selector: selectorFor(target), tag: target.localName, text: textOf(target),
      }, anchor);
    } else if (mode === "edit" && !editing) {
      hover.hidden = true;
      const host = editTarget(target);
      if (host) startEdit(host);
    }
  }, true);

  /** @param {string | null} target */
  const staysInFrame = (target) => !target || target === "_self";

  /**
   * True when a click on this link will load another page in this frame.
   * @param {MouseEvent} event
   */
  const clickLeaves = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    const link = event.target instanceof Element ? event.target.closest("a, area") : null;
    const href = link?.getAttribute("href") ?? link?.getAttribute("xlink:href");
    if (!link || !href || link.hasAttribute("download")) return false;
    if (!staysInFrame(link.getAttribute("target"))) return false;
    let url;
    try {
      url = new URL(href, document.baseURI);
    } catch {
      return false;
    }
    if (url.protocol === "javascript:") return false;
    // A link to a fragment of this page, including "#", does not load a page.
    return !(url.href.includes("#") && url.href.split("#")[0] === location.href.split("#")[0]);
  };

  // Tells the shell that a person, not the board, is leaving the page, so the
  // shell does not count it as the board navigating away by itself.
  const leaving = () => window.frameElement?.setAttribute("data-sketchboard-leaving", "");

  // These run after the board's own handlers, so a click or submit the board
  // cancels is not reported.
  window.addEventListener("click", (event) => {
    if (event.isTrusted && mode === "none" && !event.defaultPrevented && clickLeaves(event)) leaving();
  });
  window.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const target = event.submitter?.getAttribute("formtarget") ?? form?.getAttribute("target") ?? null;
    if (event.isTrusted && mode === "none" && !event.defaultPrevented && staysInFrame(target)) leaving();
  });

  // A board script can also leave the page in answer to a person's input, for
  // example a button that sets location.href. A navigation that starts soon
  // after such input is counted as started by the person. beforeunload fires
  // when the navigation starts, so a slow next page does not matter. The
  // handler never asks the person to confirm leaving.
  let lastInput = -Infinity;
  for (const type of ["pointerdown", "click", "keydown", "submit"]) {
    window.addEventListener(type, (event) => {
      if (event.isTrusted && mode === "none") lastInput = performance.now();
    }, true);
  }
  window.addEventListener("beforeunload", () => {
    if (performance.now() - lastInput < INPUT_LEAVE_MS) leaving();
  });

  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    if (editing) {
      // Space and Enter would also activate the edited element (a button,
      // link, summary or label), so the overlay handles both itself.
      if (event.key === "Escape") {
        swallow(event);
        finishEdit(false);
      } else if (event.key === "Enter") {
        swallow(event);
        if (!event.shiftKey) finishEdit(true);
      } else if (event.key === " ") {
        swallow(event);
        document.execCommand("insertText", false, " ");
      }
      return;
    }
    if (event.key === "Escape") post({ sketchboard: 1, type: "key", key: "Escape", down: true });
    else if (event.key === " " && (event.target === document.body || event.target === document.documentElement)) {
      event.preventDefault();
      if (!event.repeat) post({ sketchboard: 1, type: "key", key: " ", down: true });
    }
  }, true);

  window.addEventListener("keyup", (event) => {
    if (!event.isTrusted) return;
    if (editing && (event.key === " " || event.key === "Enter")) swallow(event);
    else if (event.key === " ") post({ sketchboard: 1, type: "key", key: " ", down: false });
  }, true);

  window.addEventListener("scroll", () => {
    hover.hidden = true;
  }, true);

  window.addEventListener("wheel", (event) => {
    if (!event.isTrusted || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : 1;
    post({ sketchboard: 1, type: "zoom", deltaY: event.deltaY * unit, x: event.clientX, y: event.clientY });
  }, { passive: false, capture: true });

  post({ sketchboard: 1, type: "ready" });
}

if (framedByShell()) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
