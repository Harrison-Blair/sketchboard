import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, cli, http, makeHome, openEvents, readState, until } from "./helpers.js";

const OVERLAY = '<script type="module" src="/__sketchboard/overlay.js"></script>';
const root = makeHome();
let port = 0;
/** @param {string} canvas */
const dir = (canvas) => path.join(root, canvas);
// Files here are outside the root and must never be served or written.
const outer = path.dirname(root);
/** @param {string} p */
const get = (p) => http(port, "GET", p);
/**
 * @param {string} p
 * @param {unknown} body
 */
const post = (p, body) => http(port, "POST", p, { body });

before(async () => {
  const r = await cli(root, ["open", "home"]);
  assert.equal(r.code, 0, r.stderr);
  port = readState(root).port;
});

after(() => cleanup(root));

test("rejects a foreign Host and a POST with a foreign Origin", async () => {
  assert.equal((await http(port, "GET", "/__sketchboard/api/status", { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await http(port, "GET", "/__sketchboard/api/status", { headers: { Host: `127.0.0.1:${port + 1}` } })).status, 403);
  assert.equal((await http(port, "GET", "/__sketchboard/api/status", { headers: { Host: `localhost:${port}` } })).status, 200);

  const body = { canvas: "home", items: [] };
  const foreign = await http(port, "POST", "/__sketchboard/api/send", { body, headers: { Origin: "http://evil.example" } });
  assert.equal(foreign.status, 403);
  assert.equal((await http(port, "POST", "/__sketchboard/api/send", { body, headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await http(port, "POST", "/__sketchboard/api/send", { body, headers: { Origin: `http://localhost:${port}` } })).status, 200);
  assert.equal((await post("/__sketchboard/api/send", body)).status, 200, "no Origin (CLI) is allowed");
});

test("serves protocol.js, 404s missing ui files, and serves the shell from ui/ when present", async () => {
  const proto = await get("/__sketchboard/protocol.js");
  assert.equal(proto.status, 200);
  assert.match(String(proto.headers["content-type"]), /^text\/javascript/);
  assert.equal(proto.text, readFileSync(new URL("../src/protocol.js", import.meta.url), "utf8"));

  assert.equal((await get("/__sketchboard/no-such-file.js")).status, 404);
  assert.equal((await get("/__sketchboard/..%2fpackage.json")).status, 404);

  const hasShell = existsSync(new URL("../ui/shell.html", import.meta.url));
  for (const p of ["/", "/c/home"]) {
    const r = await get(p);
    assert.equal(r.status, hasShell ? 200 : 404, p);
    if (hasShell) assert.match(String(r.headers["content-type"]), /^text\/html/);
  }
  assert.equal((await get("/c/..%2f..")).status, 400);
});

test("serves root files under /design/ with content types and injects the overlay into HTML", async () => {
  writeFileSync(path.join(dir("home"), "a.html"), "<html><body><h1>A</h1></body></html>");
  writeFileSync(path.join(dir("home"), "frag.html"), "<h1>no body tag</h1>");
  mkdirSync(path.join(root, "systems", "base"), { recursive: true });
  writeFileSync(path.join(root, "systems", "base", "tokens.css"), ":root { --x: 1; }");

  const a = await get("/design/home/a.html");
  assert.equal(a.status, 200);
  assert.match(String(a.headers["content-type"]), /^text\/html/);
  assert.equal(a.text, `<html><body><h1>A</h1>${OVERLAY}</body></html>`);
  assert.equal((await get("/design/home/frag.html")).text, `<h1>no body tag</h1>${OVERLAY}`);
  assert.equal((await get("/design/home/a.html?raw=1")).text, "<html><body><h1>A</h1></body></html>");

  const css = await get("/design/systems/base/tokens.css");
  assert.equal(css.status, 200);
  assert.match(String(css.headers["content-type"]), /^text\/css/);
  assert.match(String((await get("/design/home/canvas.json")).headers["content-type"]), /^application\/json/);
  assert.equal((await get("/design/home/missing.html")).status, 404);
  assert.equal((await get("/design/home/")).status, 404);
});

test("blocks the .state folder and path traversal", async () => {
  writeFileSync(path.join(outer, "secret.txt"), "secret");
  for (const p of [
    "/design/.state/server.json",
    "/design/.STATE/server.json",
    "/design/%2estate/server.json",
    "/design/.state/.gitignore",
    "/design/../secret.txt",
    "/design/home/../../secret.txt",
    "/design/%2e%2e/secret.txt",
    "/design/home/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/design/..%2fsecret.txt",
    "/design/..%5csecret.txt",
    "/design/home/..%5c..%5csecret.txt",
    "/design/%252e%252e/secret.txt",
    "/design/home/a.html%00",
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
  }
});

test("does not follow a symlink out of the root", async (t) => {
  try {
    symlinkSync(path.join(outer, "secret.txt"), path.join(dir("home"), "link.txt"), "file");
  } catch {
    return t.skip("cannot create symlinks here (Windows without the privilege)");
  }
  writeFileSync(path.join(outer, "secret.txt"), "secret");
  assert.equal((await get("/design/home/link.txt")).status, 404);
});

test("lists canvases and reads missing notes, compare, and order as empty", async () => {
  mkdirSync(dir("bare"), { recursive: true });
  writeFileSync(path.join(dir("bare"), "canvas.json"), JSON.stringify({ v: 1, title: "Bare", boards: {}, extra: 7 }));
  const index = (await get("/__sketchboard/api/canvas/bare")).json();
  assert.deepEqual(index, { v: 1, title: "Bare", boards: {}, extra: 7, order: [], notes: {}, compare: {} });
  assert.equal((await get("/__sketchboard/api/canvas/nope")).status, 404);
  assert.equal((await get("/__sketchboard/api/canvas/..%2fx")).status, 400);

  const names = (await get("/__sketchboard/api/canvases")).json().canvases.map((/** @type {any} */ c) => c.name);
  assert.ok(names.includes("home") && names.includes("bare"));
  assert.ok(!names.includes("systems") && !names.includes(".state"));
});

test("notes: add, replace, and delete while keeping every other key", async () => {
  mkdirSync(dir("notes"), { recursive: true });
  const file = path.join(dir("notes"), "canvas.json");
  writeFileSync(file, JSON.stringify({ v: 1, title: "N", boards: { "a.html": { x: 0, y: 0, w: 10, h: 10, title: "A" } }, custom: { keep: true } }));

  const sticky = { kind: "sticky", x: 1, y: 2, w: 200, text: "Keep the gauge" };
  const title = { kind: "title", x: 0, y: -10, text: "Directions" };
  let r = await post("/__sketchboard/api/canvas/notes/notes", { set: { s1: sticky, t1: title } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { notes: { s1: sticky, t1: title } });

  // An agent edits canvas.json between browser writes; the next write keeps that edit.
  const agentEdit = JSON.parse(readFileSync(file, "utf8"));
  agentEdit.boards["b.html"] = { x: 20, y: 0, w: 10, h: 10, title: "B" };
  writeFileSync(file, JSON.stringify(agentEdit));

  const moved = { ...sticky, x: 50 };
  r = await post("/__sketchboard/api/canvas/notes/notes", { set: { s1: moved }, remove: ["t1"] });
  assert.deepEqual(r.json(), { notes: { s1: moved } });
  const disk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(disk.custom, { keep: true });
  assert.deepEqual(Object.keys(disk.boards), ["a.html", "b.html"]);
  assert.deepEqual(disk.notes, { s1: moved });
  assert.equal("order" in disk, false, "the notes write adds no keys it does not change");

  assert.equal((await post("/__sketchboard/api/canvas/nope/notes", { set: {} })).status, 404);
  assert.equal((await http(port, "GET", "/__sketchboard/api/canvas/notes/notes")).status, 405);
});

/**
 * Writes design/<canvas>/canvas.json with the given board names.
 * @param {string} canvas
 * @param {string[]} boards
 */
function writeIndex(canvas, boards) {
  mkdirSync(dir(canvas), { recursive: true });
  const rects = Object.fromEntries(boards.map((b) => [b, { x: 0, y: 0, w: 100, h: 100, title: b }]));
  writeFileSync(path.join(dir(canvas), "canvas.json"), JSON.stringify({ v: 1, title: canvas, boards: rects }));
}

/**
 * Creates a symlink, or returns false where the OS does not allow it
 * (Windows without the privilege).
 * @param {string} target
 * @param {string} link
 * @param {"file" | "dir"} type
 */
function trySymlink(target, link, type) {
  try {
    symlinkSync(target, link, type === "dir" ? "junction" : "file");
    return true;
  } catch {
    return false;
  }
}

test("hybrid edit applies only when one text run equals the old text", async () => {
  writeIndex("home", ["edit.html", "gone.html"]);
  const file = path.join(dir("home"), "edit.html");
  const source = "<body><h1>Welcome home</h1><p>Buy now</p><p>Buy now</p></body>";
  writeFileSync(file, source);
  /** @param {string} oldText @param {string} newText */
  const edit = (oldText, newText) => post("/__sketchboard/api/edit", { canvas: "home", board: "edit.html", selector: "h1", oldText, newText });

  let r = await edit("Welcome home", "Hello & <welcome>");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json().item, {
    kind: "edit",
    board: "edit.html",
    selector: "h1",
    oldText: "Welcome home",
    newText: "Hello & <welcome>",
    applied: true,
  });
  const afterOnce = "<body><h1>Hello &amp; &lt;welcome&gt;</h1><p>Buy now</p><p>Buy now</p></body>";
  assert.equal(readFileSync(file, "utf8"), afterOnce);

  r = await edit("Buy now", "Buy later");
  assert.equal(r.json().item.applied, false);
  assert.equal(readFileSync(file, "utf8"), afterOnce);

  r = await edit("Not in the file", "x");
  assert.equal(r.json().item.applied, false);
  assert.equal(readFileSync(file, "utf8"), afterOnce);

  r = await edit("", "x");
  assert.equal(r.json().item.applied, false);
  assert.equal(readFileSync(file, "utf8"), afterOnce);

  assert.equal((await post("/__sketchboard/api/edit", { canvas: "home", board: "../x.html", selector: "", oldText: "a", newText: "b" })).status, 400);
  assert.equal((await post("/__sketchboard/api/edit", { canvas: "home", board: "gone.html", selector: "", oldText: "a", newText: "b" })).status, 404);
});

test("hybrid edit matches only a whole trimmed text run", async () => {
  writeIndex("whole", ["w.html"]);
  const file = path.join(dir("whole"), "w.html");
  /**
   * @param {string} source
   * @param {string} oldText
   * @param {string | null} expected The file after the edit, or null if the edit must not apply.
   */
  const check = async (source, oldText, expected) => {
    writeFileSync(file, source);
    const r = await post("/__sketchboard/api/edit", { canvas: "whole", board: "w.html", selector: "p", oldText, newText: "Sale" });
    assert.equal(r.json().item.applied, expected !== null, source);
    assert.equal(readFileSync(file, "utf8"), expected ?? source);
  };

  // A price toggle shows "$120/yr" from a data attribute; the edit must not rewrite another sentence.
  await check('<p id="price" data-yearly="$120/yr">$12/mo</p><p>Annual plan: $120/yr</p>', "$120/yr", null);
  // The edited element's text crosses a tag, so only a longer run elsewhere contains it.
  await check('<p id="price">$<span>12</span>/mo</p><p>Pro is $12/mo, billed yearly.</p>', "$12/mo", null);
  // Whitespace around the run stays as written.
  await check("<p>\n  Save\n</p>", "Save", "<p>\n  Sale\n</p>");
  await check("<p>\r\n  Save\r\n</p>", "Save", "<p>\r\n  Sale\r\n</p>");
  // Two runs equal to the old text.
  await check("<p>Save</p><p> Save </p>", "Save", null);
});

test("hybrid edit counts only visible text", async () => {
  writeIndex("vis", ["v.html"]);
  const file = path.join(dir("vis"), "v.html");
  /** @param {string} oldText @param {string} newText */
  const edit = (oldText, newText) => post("/__sketchboard/api/edit", { canvas: "vis", board: "v.html", selector: "p", oldText, newText });
  /**
   * @param {string} source
   * @param {string} oldText
   * @param {string | null} expected The file after the edit, or null if the edit must not apply.
   */
  const check = async (source, oldText, expected) => {
    writeFileSync(file, source);
    const r = await edit(oldText, "Sale");
    assert.equal(r.json().item.applied, expected !== null, source);
    assert.equal(readFileSync(file, "utf8"), expected ?? source);
  };

  // The only match is in a script.
  await check('<body><p>Hi</p><script>const label = "Buy now";</script></body>', "Buy now", null);
  // A match in text and one in a script: the script may render the text too, so the edit does not apply.
  await check('<body><p>Buy now</p><script>go("Buy now")</script></body>', "Buy now", null);
  // Script content ends at its closing tag (upper-case tag, "</script >" with a space): text after it counts.
  await check('<body><SCRIPT type="module">go()</script ><p>Buy now</p></body>', "Buy now", '<body><SCRIPT type="module">go()</script ><p>Sale</p></body>');
  await check("<script>go()</SCRIPT><p>Buy now</p>", "Buy now", "<script>go()</SCRIPT><p>Sale</p>");
  await check('<body><p>Buy now</p><a title="Buy now" href="#">x</a></body>', "Buy now", '<body><p>Sale</p><a title="Buy now" href="#">x</a></body>');
  await check("<body><!-- a > Buy now --><p>Buy now</p></body>", "Buy now", "<body><!-- a > Buy now --><p>Sale</p></body>");
  await check("<style>.x::after { content: 'Buy now' }</style><p>Buy now</p>", "Buy now", "<style>.x::after { content: 'Buy now' }</style><p>Sale</p>");
  // Boards often repeat the h1 in the title.
  await check("<head><title>Acme Pricing</title ></head><body><h1>Pricing</h1></body>", "Pricing", "<head><title>Acme Pricing</title ></head><body><h1>Sale</h1></body>");
  await check("<TITLE>Pricing</TITLE><template><p>Pricing</p></template><noscript>Pricing</noscript><textarea>Pricing</textarea><h1>Pricing</h1>", "Pricing", "<TITLE>Pricing</TITLE><template><p>Pricing</p></template><noscript>Pricing</noscript><textarea>Pricing</textarea><h1>Sale</h1>");
  // A match only in markup does not apply.
  await check('<p data-x="Buy now">Hi</p><!-- Buy now --><Style>/* Buy now */</style>', "Buy now", null);
  // A ">" inside a quoted attribute value stays inside the tag; an apostrophe in text is plain text.
  await check(`<p title="a > Buy now">Don't Buy now</p>`, "Don't Buy now", `<p title="a > Buy now">Sale</p>`);
  await check("<p data-don't>Buy now</p>", "Buy now", "<p data-don't>Sale</p>");
  // Two visible matches still do not apply; a match may not cross a tag.
  await check("<p>Buy now</p><p>Buy now</p>", "Buy now", null);
  await check("<p>Buy <b>now</b></p>", "Buy now", null);
  // A "<" not followed by a letter, "/", "!" or "?" is text.
  await check("<p>1 < 2 Buy</p>", "1 < 2 Buy", "<p>Sale</p>");
  // Text after the last tag counts.
  await check("<p>x</p>Buy now", "Buy now", "<p>x</p>Sale");
  // Whitespace may separate "=" from a quoted value that holds ">".
  await check('<p title= "a > Buy now">Buy now</p>', "Buy now", '<p title= "a > Buy now">Sale</p>');
  // An unterminated comment or raw-text element runs to the end of the file.
  await check("<p>Buy now</p><!-- Buy now", "Buy now", "<p>Sale</p><!-- Buy now");
  await check("<p>Buy now</p><style>/* Buy now", "Buy now", "<p>Sale</p><style>/* Buy now");
  await check('<p>Buy now</p><script>go("Buy now")', "Buy now", null);
  // The parser ignores "/>" on <textarea>, so its contents are still raw text.
  await check("<textarea/>Buy now</textarea><p>Buy now</p>", "Buy now", "<textarea/>Buy now</textarea><p>Sale</p>");
  await check("<p>Buy</p>", "Buy</p>", null);
});

test("hybrid edit refuses text that a script also contains", async () => {
  writeIndex("plans", ["plans.html"]);
  const file = path.join(dir("plans"), "plans.html");
  const source = `<!doctype html>
<table><tr><th>Starter</th><th>Team</th></tr></table>
<ul id="cards"></ul>
<script>
  const plans = ["Starter", "Team", "Enterprise"];
  document.getElementById("cards").innerHTML = plans.map((p) => \`<li>\${p}</li>\`).join("");
</script>
`;
  writeFileSync(file, source);
  const r = await post("/__sketchboard/api/edit", { canvas: "plans", board: "plans.html", selector: "th", oldText: "Starter", newText: "Basic" });
  assert.equal(r.json().item.applied, false);
  assert.equal(readFileSync(file, "utf8"), source);

  // A script string can hold the text with references and insert it as HTML.
  const encoded = '<p>Fish &amp; Chips</p><script>menu.innerHTML = "<li>Fish &amp; Chips</li>";</script>';
  writeFileSync(file, encoded);
  const r2 = await post("/__sketchboard/api/edit", { canvas: "plans", board: "plans.html", selector: "p", oldText: "Fish & Chips", newText: "Fries" });
  assert.equal(r2.json().item.applied, false);
  assert.equal(readFileSync(file, "utf8"), encoded);

  // The script holds the reference text itself; only the visible text's decoded form matches it.
  const raw = '<p>Tom &amp;amp; Jerry</p><script>el.textContent = "Tom &amp; Jerry";</script>';
  writeFileSync(file, raw);
  const r3 = await post("/__sketchboard/api/edit", { canvas: "plans", board: "plans.html", selector: "p", oldText: "Tom &amp; Jerry", newText: "Tom and Jerry" });
  assert.equal(r3.json().item.applied, false);
  assert.equal(readFileSync(file, "utf8"), raw);
});

test("hybrid edit matches decoded visible text and replaces the original entity text", async () => {
  writeIndex("ent", ["e.html"]);
  const file = path.join(dir("ent"), "e.html");
  /**
   * @param {string} source
   * @param {string} oldText
   * @param {string} newText
   * @param {string | null} expected The file after the edit, or null if the edit must not apply.
   */
  const check = async (source, oldText, newText, expected) => {
    writeFileSync(file, source);
    const r = await post("/__sketchboard/api/edit", { canvas: "ent", board: "e.html", selector: "p", oldText, newText });
    assert.equal(r.json().item.applied, expected !== null, source);
    assert.equal(readFileSync(file, "utf8"), expected ?? source);
  };

  await check("<p>Fish &amp; Chips</p>", "Fish & Chips", "Fish & Fries", "<p>Fish &amp; Fries</p>");
  // Only the trimmed run changes, so whitespace references around it stay as written.
  await check("<p>&nbsp;Fish &amp; Chips&#10;</p>", "Fish & Chips", "Fries", "<p>&nbsp;Fries&#10;</p>");
  await check("<p>2019&mdash;2024</p>", "2019\u20142024", "2025", "<p>2025</p>");
  await check("<p>Next &#8594; step &#x2192;</p>", "Next \u2192 step \u2192", "Go", "<p>Go</p>");
  await check("<p>Price:&nbsp;10&nbsp;EUR</p>", "Price:\u00a010\u00a0EUR", "Price: 12 EUR", "<p>Price: 12 EUR</p>");
  await check("<p>Line one\r\nline two</p>", "Line one\nline two", "1", "<p>1</p>");
  // Upper-case X and hex digits; 0, surrogates, and values past U+10FFFF decode to U+FFFD.
  await check("<p>&#X2192; &#xA9;</p>", "\u2192 \u00a9", "Go", "<p>Go</p>");
  await check("<p>a&#0;b&#xD800;c&#x110000;d</p>", "a\ufffdb\ufffdc\ufffdd", "x", "<p>x</p>");
  // Code points past U+FFFF (emoji) decode as themselves.
  await check("<p>Hi &#x1F44B; &#128075;</p>", "Hi \u{1F44B} \u{1F44B}", "Hey", "<p>Hey</p>");
  // An entity form and a plain form of the same text are two matches.
  await check("<p>A &amp; B</p><p>A & B</p>", "A & B", "C", null);
  // An unknown entity stays literal text.
  await check("<p>&madeup; text</p>", "&madeup; text", "Known", "<p>Known</p>");
});

test("send and wait: per canvas, no canvas, and immediate return of held items", async () => {
  mkdirSync(dir("w1"), { recursive: true });
  const item = { kind: "element", board: "a.html", selector: "h1", tag: "h1", text: "A", note: "n" };
  let r = await post("/__sketchboard/api/send", { canvas: "w1", items: [item], message: "  " });
  assert.deepEqual(r.json(), { held: 1 });
  r = await post("/__sketchboard/api/send", { canvas: "w1", items: [], message: "go" });
  assert.deepEqual(r.json(), { held: 2 });

  const status = (await get("/__sketchboard/api/status")).json();
  assert.equal(status.canvases.find((/** @type {any} */ c) => c.name === "home")?.held, 0);

  r = await get("/__sketchboard/api/wait?canvas=w1&timeout=5");
  assert.deepEqual(r.json(), { canvas: "w1", items: [item, { kind: "message", text: "go" }] });
  r = await get("/__sketchboard/api/wait?canvas=w1&timeout=0.1");
  assert.deepEqual(r.json(), { canvas: "w1", items: [], timedOut: true });

  const pending = get("/__sketchboard/api/wait?timeout=10");
  await until(async () => (await get("/__sketchboard/api/status")).json().waiting === 1);
  await post("/__sketchboard/api/send", { canvas: "w1", items: [item] });
  assert.deepEqual((await pending).json(), { canvas: "w1", items: [item] });

  assert.equal((await post("/__sketchboard/api/send", { canvas: "w1" })).status, 400);
  assert.equal((await post("/__sketchboard/api/send", { canvas: "../x", items: [] })).status, 400);
});

test("event stream: board, index, and system events; the stream counts as a tab", async () => {
  mkdirSync(dir("live"), { recursive: true });
  writeFileSync(path.join(dir("live"), "canvas.json"), JSON.stringify({ v: 1, title: "Live", boards: {} }));
  writeFileSync(path.join(dir("live"), "b.html"), "<p>1</p>");
  const stream = await openEvents(port, "live");
  try {
    const tabs = () => get("/__sketchboard/api/canvases").then((r) => r.json().canvases.find((/** @type {any} */ c) => c.name === "live")?.tabs);
    assert.equal(await tabs(), 1);

    /**
     * Repeats `change` until a matching event arrives, because a new watcher
     * may miss the first change on some platforms.
     * @param {() => void} change
     * @param {(e: any) => boolean} match
     */
    const expectEvent = async (change, match) => {
      stream.events.length = 0;
      let n = 0;
      await until(() => {
        if (n++ % 20 === 0) change();
        return stream.events.some(match);
      }, 8000);
    };

    await expectEvent(
      () => writeFileSync(path.join(dir("live"), "b.html"), `<p>${Date.now()}</p>`),
      (e) => e.type === "board" && e.canvas === "live" && e.board === "b.html",
    );

    // Editors that save through a rename.
    await expectEvent(
      () => {
        const tmp = path.join(dir("live"), ".b.html.tmp");
        writeFileSync(tmp, `<p>${Date.now()}</p>`);
        renameSync(tmp, path.join(dir("live"), "b.html"));
      },
      (e) => e.type === "board" && e.board === "b.html",
    );

    await expectEvent(
      () => writeFileSync(path.join(dir("live"), "canvas.json"), JSON.stringify({ v: 1, title: `Live ${Date.now()}`, boards: {} })),
      (e) => e.type === "index" && e.canvas === "live" && e.index.title.startsWith("Live ") && e.index.notes && e.index.order,
    );

    mkdirSync(path.join(root, "systems", "base"), { recursive: true });
    await expectEvent(
      () => writeFileSync(path.join(root, "systems", "base", "tokens.css"), `:root { --t: ${Date.now()}; }`),
      (e) => e.type === "system",
    );

    // A system folder created while the stream is open is watched too.
    mkdirSync(path.join(root, "systems", "fresh"), { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    await expectEvent(
      () => writeFileSync(path.join(root, "systems", "fresh", "tokens.css"), `:root { --t: ${Date.now()}; }`),
      (e) => e.type === "system",
    );

    // Debounce: a burst of writes to one file yields one event.
    await new Promise((r) => setTimeout(r, 300));
    stream.events.length = 0;
    for (let i = 0; i < 10; i++) writeFileSync(path.join(dir("live"), "b.html"), `<p>burst ${i}</p>`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(stream.events.filter((e) => e.type === "board" && e.board === "b.html").length, 1);

    assert.equal((await get("/__sketchboard/api/events?canvas=nope")).status, 404);
    assert.equal((await get("/__sketchboard/api/events")).status, 400);
  } finally {
    stream.close();
  }
});


test("hybrid edit writes only HTML boards listed in canvas.json, inside the root", async (t) => {
  writeIndex("guard", ["a.html", "notes.txt", "link.html"]);
  writeFileSync(path.join(dir("guard"), "a.html"), "<p>one</p>");
  writeFileSync(path.join(dir("guard"), "b.html"), "<p>one</p>");
  writeFileSync(path.join(dir("guard"), "notes.txt"), "one");
  const indexBefore = readFileSync(path.join(dir("guard"), "canvas.json"), "utf8");
  /** @param {string} board @param {string} oldText */
  const edit = (board, oldText) => post("/__sketchboard/api/edit", { canvas: "guard", board, selector: "p", oldText, newText: "two" });

  let r = await edit("canvas.json", '"v":1');
  assert.equal(r.status, 400);
  assert.equal(readFileSync(path.join(dir("guard"), "canvas.json"), "utf8"), indexBefore);

  r = await edit("b.html", "one");
  assert.equal(r.status, 400, "a board file that is not in canvas.json");
  assert.equal(readFileSync(path.join(dir("guard"), "b.html"), "utf8"), "<p>one</p>");

  r = await edit("notes.txt", "one");
  assert.equal(r.status, 400, "a non-HTML entry in boards");
  assert.equal(readFileSync(path.join(dir("guard"), "notes.txt"), "utf8"), "one");

  assert.equal((await edit("a.html", "one")).json().item.applied, true, "a listed board still works");

  const outside = path.join(outer, "outside.html");
  writeFileSync(outside, "<p>one</p>");
  if (!trySymlink(outside, path.join(dir("guard"), "link.html"), "file")) return t.skip("cannot create symlinks here");
  r = await edit("link.html", "one");
  assert.equal(r.status, 404);
  assert.equal(readFileSync(outside, "utf8"), "<p>one</p>");
});

test("notes and open do not write through symlinks out of the root", async (t) => {
  const outsideDir = path.join(outer, "outside-canvas");
  mkdirSync(outsideDir, { recursive: true });
  if (!trySymlink(outsideDir, dir("linked"), "dir")) return t.skip("cannot create symlinks here");
  const r = await post("/__sketchboard/api/open", { canvas: "linked" });
  assert.equal(r.status, 400);
  assert.equal(existsSync(path.join(outsideDir, "canvas.json")), false);

  mkdirSync(dir("linkidx"), { recursive: true });
  const outsideIndex = path.join(outer, "outside-index.json");
  const original = JSON.stringify({ v: 1, title: "x", boards: {} });
  writeFileSync(outsideIndex, original);
  if (!trySymlink(outsideIndex, path.join(dir("linkidx"), "canvas.json"), "file")) return t.skip("cannot create symlinks here");
  const n = await post("/__sketchboard/api/canvas/linkidx/notes", { set: { t: { kind: "title", x: 0, y: 0, text: "x" } } });
  assert.equal(n.status, 404);
  assert.equal(readFileSync(outsideIndex, "utf8"), original);
});

test("API requests from another site are rejected and do not consume feedback", async () => {
  mkdirSync(dir("sfs"), { recursive: true });
  const item = { kind: "message", text: "keep me" };
  await post("/__sketchboard/api/send", { canvas: "sfs", items: [item] });
  for (const site of ["cross-site", "same-site"]) {
    const r = await http(port, "GET", "/__sketchboard/api/wait?canvas=sfs&timeout=0", { headers: { "Sec-Fetch-Site": site } });
    assert.equal(r.status, 403, site);
    assert.equal((await http(port, "GET", "/__sketchboard/api/events?canvas=home", { headers: { "Sec-Fetch-Site": site } })).status, 403);
  }
  for (const site of ["same-origin", "none"]) {
    assert.equal((await http(port, "GET", "/__sketchboard/api/status", { headers: { "Sec-Fetch-Site": site } })).status, 200, site);
  }
  writeFileSync(path.join(dir("home"), "nav.html"), "<p>nav</p>");
  assert.equal((await http(port, "GET", "/design/home/nav.html", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 200, "navigation to boards is not affected");
  const waited = await cli(root, ["wait", "sfs", "--timeout", "1"]);
  assert.deepEqual(JSON.parse(waited.stdout), { canvas: "sfs", items: [item] });
});

test("system events continue after systems/ is deleted and created again", async () => {
  writeIndex("sysagain", []);
  mkdirSync(path.join(root, "systems", "old"), { recursive: true });
  const stream = await openEvents(port, "sysagain");
  /**
   * @param {string} file
   */
  const expectSystem = async (file) => {
    stream.events.length = 0;
    let n = 0;
    await until(() => {
      if (n++ % 20 === 0) writeFileSync(file, `:root { --t: ${Date.now()}; }`);
      return stream.events.some((e) => e.type === "system");
    }, 8000);
  };
  try {
    await expectSystem(path.join(root, "systems", "old", "tokens.css"));
    rmSync(path.join(root, "systems"), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 200));
    mkdirSync(path.join(root, "systems", "x"), { recursive: true });
    // Let the events from creating the folders pass, so only a tokens.css write can satisfy the check.
    await new Promise((r) => setTimeout(r, 300));
    await expectSystem(path.join(root, "systems", "x", "tokens.css"));
  } finally {
    stream.close();
  }
});

test("system events for folders moved into place and system folders created again", async () => {
  writeIndex("sysmove", []);
  const systems = path.join(root, "systems");
  mkdirSync(systems, { recursive: true });
  const stream = await openEvents(port, "sysmove");
  const settle = () => new Promise((r) => setTimeout(r, 300));
  /** A change that must send one system event by itself, with no later writes. */
  const expectOnce = async (/** @type {() => void} */ change) => {
    await settle();
    stream.events.length = 0;
    change();
    await until(() => stream.events.some((e) => e.type === "system"), 3000).catch(() => assert.fail("no system event"));
  };
  /** Repeats writes to `file` until a system event arrives. */
  const expectWrites = async (/** @type {string} */ file) => {
    await settle();
    stream.events.length = 0;
    let n = 0;
    await until(() => {
      if (n++ % 20 === 0) writeFileSync(file, `:root { --t: ${Date.now()}; }`);
      return stream.events.some((e) => e.type === "system");
    }, 8000).catch(() => assert.fail(`no system event for writes to ${file}`));
  };
  /** @param {string} name @param {string} rel */
  const stage = (name, rel) => {
    const dirPath = path.join(root, name, ...rel.split("/"));
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(path.join(dirPath, "tokens.css"), ":root {}");
    return path.join(root, name);
  };
  try {
    // A finished system folder moved into systems/.
    const a = stage("stage-a", "");
    await expectOnce(() => renameSync(a, path.join(systems, "a")));
    // A watched system folder deleted and created again.
    await expectWrites(path.join(systems, "a", "tokens.css"));
    rmSync(path.join(systems, "a"), { recursive: true, force: true });
    await settle();
    mkdirSync(path.join(systems, "a"));
    await expectWrites(path.join(systems, "a", "tokens.css"));
    // A whole systems/ folder moved into place.
    const staged = stage("stage-systems", "b");
    rmSync(systems, { recursive: true, force: true });
    await expectOnce(() => renameSync(staged, systems));
    // systems/ itself is watched again: a system folder created later is seen.
    mkdirSync(path.join(systems, "c"));
    await expectWrites(path.join(systems, "c", "tokens.css"));
  } finally {
    stream.close();
    for (const name of ["stage-a", "stage-systems"]) rmSync(path.join(root, name), { recursive: true, force: true });
  }
});

test("events continue after a canvas folder is deleted and created again", async () => {
  writeIndex("again", ["b.html"]);
  writeFileSync(path.join(dir("again"), "b.html"), "<p>1</p>");
  const stream = await openEvents(port, "again");
  try {
    let n = 0;
    await until(() => {
      if (n++ % 20 === 0) writeFileSync(path.join(dir("again"), "b.html"), `<p>${Date.now()}</p>`);
      return stream.events.some((e) => e.type === "board");
    }, 8000);
    rmSync(dir("again"), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 200));
    stream.events.length = 0;
    // Written in one step with the folder, before a new watcher can start: the server must send it anyway.
    writeIndex("again", ["b.html"]);
    await until(() => stream.events.some((e) => e.type === "index" && e.canvas === "again"), 8000).catch(() => assert.fail("no index event after the canvas folder came back"));
    n = 0;
    await until(() => {
      if (n++ % 20 === 0) writeFileSync(path.join(dir("again"), "b.html"), `<p>${Date.now()}</p>`);
      return stream.events.some((e) => e.type === "board" && e.board === "b.html");
    }, 8000);
  } finally {
    stream.close();
  }
});
