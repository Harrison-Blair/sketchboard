import { test, expect, boardHtml, boardFrame, boardFrameHandle, useTool, waitForMode } from "./fixtures.js";

const EDIT_START = process.platform === "darwin" ? "Meta+ArrowUp" : "ControlOrMeta+Home";
const EDIT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "ControlOrMeta+End";
const SELECT_TO_END = process.platform === "darwin" ? "Meta+Shift+ArrowDown" : "ControlOrMeta+Shift+End";

const INDEX = {
  v: 1,
  title: "E2E canvas",
  boards: { "c.html": { x: 0, y: 0, w: 600, h: 400, title: "Copy" } },
  order: ["c.html"],
  notes: {},
  compare: {},
};

/**
 * The feedback items waiting in Unsent, as the shell stores them.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<any[]>}
 */
function unsentItems(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("sketchboard:unsent:e2e") ?? "[]").map((/** @type {any} */ u) => u.item));
}

/**
 * What the server serves for a board, read apart from the live page: the
 * source position of the first element that matches the selector (searched
 * in <template> content too), and the file version.
 * @param {import("@playwright/test").Page} page
 * @param {string} board
 * @param {string} selector
 * @returns {Promise<{ src: number | null, ver: string | null }>}
 */
async function served(page, board, selector) {
  const url = (await boardFrameHandle(page, board)).url();
  return page.evaluate(async ({ url, selector }) => {
    const doc = new DOMParser().parseFromString(await (await fetch(url, { cache: "no-store" })).text(), "text/html");
    const el = doc.querySelector(selector) ?? [...doc.querySelectorAll("template")].map((t) => t.content.querySelector(selector)).find(Boolean) ?? null;
    return {
      src: el?.hasAttribute("data-sb-src") ? Number(el.getAttribute("data-sb-src")) : null,
      ver: doc.querySelector("[data-sb-ver]")?.getAttribute("data-sb-ver") ?? null,
    };
  }, { url, selector });
}

const COPY = `
<h2 id="lede">Only once</h2>
<p class="dup">Same words</p>
<p class="dup">Same words</p>
`;

test("a unique text edit is applied to the file and a repeated one is queued for the agent", async ({ page, project }) => {
  await project.create({ "canvas.json": INDEX, "c.html": boardHtml("Copy", COPY) });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#lede")).toHaveText("Only once");
  const frame = await boardFrameHandle(page, "c.html");
  await frame.evaluate(() => Object.assign(window, { e2eMark: "before" }));
  const lede = await served(page, "c.html", "#lede");
  expect(lede.src).toEqual(expect.any(Number));
  expect(lede.ver).toEqual(expect.any(String));

  await useTool(page, "edit", ["c.html"]);
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/edit"));
  await copy.locator("#lede").click();
  await page.keyboard.type("Exactly once");
  await page.keyboard.press("Enter");

  const applied = page.locator(".unsent-item").filter({ hasText: "Exactly once" });
  await expect(applied.locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toContain("Exactly once");
  expect(await project.read("c.html")).not.toContain("Only once");
  // The file write reloads the frame; wait for it before the next edit.
  // evaluate throws while the frame is between documents; poll again then.
  await expect.poll(() => frame.evaluate(() => /** @type {any} */ (window).e2eMark).catch(() => "reloading")).toBeUndefined();
  await expect(copy.locator("#lede")).toHaveText("Exactly once");
  await waitForMode(page, "edit", ["c.html"]);
  await expect(applied.getByRole("button", { name: "Remove note (the file keeps the change)" })).toHaveAttribute("title", "Remove note (the file keeps the change)");

  await copy.locator("p.dup").first().click();
  await page.keyboard.type("Other words");
  await page.keyboard.press("Enter");

  const queued = page.locator(".unsent-item").filter({ hasText: "Other words" });
  await expect(queued.locator(".status")).toHaveText("Not applied: queued for the agent");
  await expect(queued.getByRole("button", { name: /^Remove item 2/ })).toBeVisible();
  expect((await request).postDataJSON()).toMatchObject({ selector: "#lede", src: lede.src, ver: lede.ver });
  const stored = await unsentItems(page);
  expect(stored.find((item) => item.newText === "Exactly once")).toMatchObject({ applied: true, src: lede.src, ver: lede.ver });
  expect(stored.find((item) => item.newText === "Exactly once")).not.toHaveProperty("newHtml");
  expect(stored.find((item) => item.newText === "Other words")).toHaveProperty("newHtml", "Other words");
  const source = await project.read("c.html");
  expect(source.split("Same words")).toHaveLength(3);
  expect(source).not.toContain("Other words");

  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 2 items" })).toBeVisible();
  const feedback = await project.wait();
  expect(feedback.items).toEqual([
    expect.objectContaining({ kind: "edit", board: "c.html", selector: "#lede", oldText: "Only once", newText: "Exactly once", applied: true }),
    expect.objectContaining({ kind: "edit", board: "c.html", oldText: "Same words", newText: "Other words", applied: false }),
  ]);
});

test("editing a button keeps typed spaces and does not activate the button", async ({ page, project }) => {
  const cta = `<button id="cta" onclick="sessionStorage.setItem('clicked', 'yes')">Start trial</button>`;
  await project.create({ "canvas.json": INDEX, "c.html": boardHtml("Copy", cta) });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#cta")).toHaveText("Start trial");

  await useTool(page, "edit", ["c.html"]);
  await copy.locator("#cta").click();
  await page.keyboard.type("Start free trial now");
  await page.keyboard.press("Enter");

  const applied = page.locator(".unsent-item").filter({ hasText: "Start free trial now" });
  await expect(applied.locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toContain(">Start free trial now</button>");
  await expect(copy.locator("#cta")).toHaveText("Start free trial now");
  const frame = await boardFrameHandle(page, "c.html");
  expect(await frame.evaluate(() => sessionStorage.getItem("clicked"))).toBeNull();
});

test("a second edit on an element whose first edit was not applied is queued, not applied elsewhere", async ({ page, project }) => {
  const buttons = (a) => `<button id="a">${a}</button><button id="b">Delete</button><button id="c">Remove</button>`;
  await project.create({ "canvas.json": INDEX, "c.html": boardHtml("Copy", buttons("Delete")) });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#a")).toHaveText("Delete");
  await useTool(page, "edit", ["c.html"]);

  // "Delete" occurs twice in the file, so this edit is queued.
  await copy.locator("#a").click();
  await page.keyboard.type("Remove");
  await page.keyboard.press("Enter");
  const first = page.locator(".unsent-item").filter({ hasText: "Delete" });
  await expect(first.locator(".status")).toHaveText("Not applied: queued for the agent");

  // "Remove" is now in the page but not in the file at #a. In the file it is
  // the whole text of #c, which this edit must not change.
  await copy.locator("#a").click();
  await page.keyboard.type("Remove all");
  await page.keyboard.press("Enter");
  const second = page.locator(".unsent-item").filter({ hasText: "Remove all" });
  await expect(second.locator(".status")).toHaveText("Not applied: queued for the agent");
  await expect(page.locator("#hint")).toHaveText("An earlier edit here is not in c.html yet. This edit is queued for the agent.");
  expect(await project.read("c.html")).toContain(buttons("Delete"));

  // A reload from the file makes the page match the file, so edits apply again.
  await project.write("c.html", boardHtml("Copy", buttons("Erase")));
  await expect(copy.locator("#a")).toHaveText("Erase");
  await waitForMode(page, "edit", ["c.html"]);
  await copy.locator("#a").click();
  await page.keyboard.type("Erase all");
  await page.keyboard.press("Enter");
  const third = page.locator(".unsent-item").filter({ hasText: "Erase all" });
  await expect(third.locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toContain(buttons("Erase all"));
});

const INLINE_MARKUP = [
  { name: "a price split by a span", html: '<p id="price">$<span>12</span>/mo</p><p>Pro is $12/mo, billed yearly.</p>', target: "#price", text: "$15/mo" },
  { name: "a heading with emphasis", html: '<h1 id="hero">Ship <em>faster</em></h1><p id="foot">Ship faster</p>', target: "#hero", text: "Ship sooner" },
];

for (const { name, html, target, text } of INLINE_MARKUP) {
  test(`an edit on ${name} is queued for the agent and no element in the file changes`, async ({ page, project }) => {
    const source = boardHtml("Copy", html);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator(target)).toBeVisible();
    await useTool(page, "edit", ["c.html"]);

    await copy.locator(target).click();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    const item = page.locator(".unsent-item").filter({ hasText: text });
    await expect(item.locator(".status")).toHaveText("Not applied: queued for the agent");
    await expect(page.locator("#hint")).toHaveText("The edit involves markup inside the element, so it is queued for the agent.");
    expect(await project.read("c.html")).toBe(source);
  });
}

/**
 * Reads an edit's newHtml back into an element so the test can check its
 * markup and text the way a browser parses it.
 * @param {import("@playwright/test").Page} page
 * @param {string} html
 */
function parse(page, html) {
  return page.evaluate((html) => {
    const box = document.createElement("div");
    box.innerHTML = html;
    return {
      text: box.textContent,
      links: [...box.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), text: a.textContent })),
      svgs: box.querySelectorAll("svg").length,
      brs: box.querySelectorAll("br").length,
    };
  }, html);
}

test("an edit that keeps inline markup is queued with the content the page shows", async ({ page, project }) => {
  await project.create({
    "canvas.json": INDEX,
    "c.html": boardHtml("Copy", `<p id="link">Read the <a href="/g">guide</a> first.</p>
<h1 id="hero">Plan your<br>next trip</h1>`),
  });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#hero")).toBeVisible();
  await useTool(page, "edit", ["c.html"]);

  // Edit the paragraph, then replace part of the link's word.
  await copy.locator("#link").click({ position: { x: 4, y: 6 } });
  await copy.locator("#link a").evaluate((link) => {
    const text = link.firstChild;
    if (!text) throw new Error("link text is missing");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const selection = link.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.type("rout");
  await page.keyboard.press("Enter");
  await expect(page.locator(".unsent-item").filter({ hasText: "Read the route first." }).locator(".status")).toHaveText("Not applied: queued for the agent");

  // Replace the whole heading, line break included.
  await copy.locator("#hero").click();
  await page.keyboard.type("Go anywhere");
  await page.keyboard.press("Enter");
  await expect(page.locator(".unsent-item").filter({ hasText: "Go anywhere" }).locator(".status")).toHaveText("Not applied: queued for the agent");

  const [link, hero] = await unsentItems(page);
  expect(link.newHtml).not.toContain("data-sb");
  expect(hero.newHtml).not.toContain("data-sb");
  console.log("newHtml seen:", JSON.stringify([link.newHtml, hero.newHtml]));
  expect(await parse(page, link.newHtml)).toEqual({ text: "Read the route first.", links: [{ href: "/g", text: "route" }], svgs: 0, brs: 0 });
  expect(await parse(page, hero.newHtml)).toEqual({ text: "Go anywhere", links: [], svgs: 0, brs: 0 });
  expect(link).toMatchObject({ oldText: "Read the guide first.", newText: "Read the route first.", applied: false });

  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 2 items" })).toBeVisible();
  const feedback = await project.wait();
  expect(feedback.items.map((/** @type {any} */ item) => item.newHtml)).toEqual([link.newHtml, hero.newHtml]);
});

const ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12"/></svg>';

test("an icon button's label is applied to the file when the icon stays", async ({ page, project }) => {
  const source = boardHtml("Copy", `<button id="s">${ICON} Save</button>`);
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#s")).toHaveText("Save");
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#s").click();
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Store");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").filter({ hasText: "Store" }).locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toBe(source.replace(" Save</button>", " Store</button>"));
  await expect(copy.locator("#s svg")).toHaveCount(1);
});

const CHANGED_MARKUP = [
  {
    name: "removes the icon",
    html: `<button id="s">${ICON} Save</button>`,
    target: "#s",
    text: "Store",
    // Backspace removes " Save" and then the icon.
    /** @param {import("@playwright/test").Page} page */
    edit: async (page) => {
      await page.keyboard.press("End");
      for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
      await page.keyboard.type("Store");
    },
    check: (/** @type {string} */ html) => expect(html).toBe("Store"),
  },
  {
    name: "inserts a second line",
    html: '<p id="m">One line</p>',
    target: "#m",
    text: "Line B",
    /** @param {import("@playwright/test").Page} page */
    edit: async (page) => {
      await page.keyboard.insertText("Line A\nLine B");
    },
    check: (/** @type {string} */ html) => expect(html).toBe("Line A<br>Line B"),
  },
  {
    name: "pastes two paragraphs",
    html: '<p id="m">One line</p>',
    target: "#m",
    text: "AB",
    /** @param {import("@playwright/test").Page} page */
    edit: async (page) => {
      await page.keyboard.insertText("A\n\nB");
    },
    check: (/** @type {string} */ html) => expect(html).toBe("A<br><br>B"),
  },
  {
    name: "adds a line next to a block it already had",
    html: '<div id="m"><div id="kept">Kept</div>Outro</div>',
    // The click lands on the "Outro" line, so #m is the edited element.
    target: "#m",
    at: { x: 4, y: 28 },
    text: "More",
    /** @param {import("@playwright/test").Page} page */
    edit: async (page) => {
      await page.keyboard.press("ArrowRight");
      await page.keyboard.insertText("\nMore");
    },
    check: (/** @type {string} */ html) => expect(html).toBe('<div id="kept">Kept</div>Outro<br>More'),
  },
  {
    name: "deletes only the icon",
    html: `<button id="x">${ICON} Close</button>`,
    target: "#x",
    text: "Close",
    /** @param {import("@playwright/test").Page} page */
    edit: async (page) => {
      await page.keyboard.press("Home");
      await page.keyboard.press("Delete");
    },
    check: (/** @type {string} */ html) => expect(html).not.toContain("<svg"),
  },
];

for (const { name, html, target, at, text, edit, check } of /** @type {{ name: string, html: string, target: string, at?: { x: number, y: number }, text: string, edit: (page: import("@playwright/test").Page) => Promise<void>, check: (html: string) => void }[]} */ (CHANGED_MARKUP)) {
  test(`an edit that ${name} is queued with its markup and the file is unchanged`, async ({ page, project }) => {
    const source = boardHtml("Copy", html);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator(target)).toBeVisible();
    await useTool(page, "edit", ["c.html"]);

    // Starting an edit selects the element's text: its one text node when the
    // edit is plain, or all of its content.
    await copy.locator(target).click(at ? { position: at } : {});
    await edit(page);
    await page.keyboard.press("Enter");

    const item = page.locator(".unsent-item").filter({ hasText: text });
    await expect(item.locator(".status")).toHaveText("Not applied: queued for the agent");
    const [stored] = await unsentItems(page);
    console.log(`newHtml after the edit that ${name}:`, JSON.stringify(stored.newHtml));
    check(stored.newHtml);
    expect(await project.read("c.html")).toBe(source);
  });
}

const SCRIPTED_TEXT = [
  {
    name: "a <template> clone",
    body: `<template id="row"><li>Pending</li></template><ul id="list"></ul>
<p>Status: <span class="badge">Pending</span></p>
<script>document.getElementById("list").append(document.getElementById("row").content.cloneNode(true))</script>`,
    target: "#list li",
    oldText: "Pending",
  },
  {
    name: "a script that copies an attribute",
    body: `<p id="greet" data-text="Welcome"></p><h2>Welcome</h2>
<script>const greet = document.getElementById("greet"); greet.textContent = greet.dataset.text</script>`,
    target: "#greet",
    oldText: "Welcome",
  },
  {
    name: "a script that moves the element",
    body: `<p>One</p><p>Offer ends soon</p>
<script>const aside = document.createElement("aside"); document.body.append(aside); aside.append(document.querySelectorAll("p")[1])</script>`,
    target: "aside p",
    oldText: "Offer ends soon",
  },
];

for (const { name, body, target, oldText } of SCRIPTED_TEXT) {
  test(`an edit of text from ${name} is queued and the file is unchanged`, async ({ page, project }) => {
    const source = boardHtml("Copy", body);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator(target)).toHaveText(oldText);
    await useTool(page, "edit", ["c.html"]);

    await copy.locator(target).click();
    await page.keyboard.type("Done");
    await page.keyboard.press("Enter");

    await expect(page.locator(".unsent-item").filter({ hasText: "Done" }).locator(".status")).toHaveText("Not applied: queued for the agent");
    await expect(page.locator("#hint")).toHaveText("The text is not written at this element in c.html, so the edit is queued for the agent.");
    const [stored] = await unsentItems(page);
    expect(stored).toMatchObject({ oldText, newText: "Done", newHtml: "Done" });
    expect(await project.read("c.html")).toBe(source);
  });
}

test("the source check reads the file as it is now", async ({ page, project }) => {
  await project.create({ "canvas.json": INDEX, "c.html": boardHtml("Copy", '<p id="t">First</p>') });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#t")).toHaveText("First");
  const frame = await boardFrameHandle(page, "c.html");
  await frame.evaluate(() => Object.assign(window, { e2eMark: "before" }));
  await useTool(page, "edit", ["c.html"]);
  await copy.locator("#t").click();
  await page.keyboard.type("Second");
  await page.keyboard.press("Enter");
  await expect(page.locator(".unsent-item").filter({ hasText: "Second" }).locator(".status")).toHaveText("In the file");

  // The file now holds "Second" and the page reloads with it. An edit from
  // a stale copy of the file would see "First" and queue this edit.
  await expect.poll(() => frame.evaluate(() => /** @type {any} */ (window).e2eMark).catch(() => "reloading")).toBeUndefined();
  await expect(copy.locator("#t")).toHaveText("Second");
  await waitForMode(page, "edit", ["c.html"]);
  await copy.locator("#t").click();
  await page.keyboard.type("Third");
  await page.keyboard.press("Enter");
  await expect(page.locator(".unsent-item").filter({ hasText: "Third" }).locator(".status")).toHaveText("In the file");
  expect(await project.read("c.html")).toContain('<p id="t">Third</p>');
});

test("deleting all of an element's text saves it empty", async ({ page, project }) => {
  const source = boardHtml("Copy", '<p id="t">Remove me</p>');
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#t")).toHaveText("Remove me");
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#t").click();
  await page.keyboard.press("End");
  for (let i = 0; i < "Remove me".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").filter({ hasText: "Remove me" }).locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toBe(source.replace('<p id="t">Remove me</p>', '<p id="t"></p>'));
});

const PASTES = [
  { name: "two lines", text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two paragraphs", text: "A\n\nB", html: "A<br><br>B" },
  { name: "a line that ends in a line break", text: "Line A\nLine B\n", html: "Line A<br>Line B" },
  { name: "one line and a Windows line break", text: "Line A\r\n", file: '<p id="m">Line A</p>' },
  { name: "a leading line break", text: "\nA", html: "<br>A" },
  // Delete all of the text first, then paste.
  { name: "two leading line breaks into an emptied element", empty: true, text: "\n\nA", html: "<br><br>A" },
  // Put the caret after "Hello " and paste a copied line.
  { name: "one line with a line break into the text", source: "Hello world", caret: 6, text: "big\n", file: '<p id="m">Hello bigworld</p>' },
  // In these, insertParagraph adds a "\n" character, not a block.
  { name: "two lines into a button", element: '<button id="m">Click</button>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into a table cell", element: '<table><tr><td id="m">Cell</td></tr></table>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into a table header cell", element: '<table><tr><th id="m">Head</th></tr></table>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into a span in a paragraph", element: '<p>Say <span id="m">Hi</span></p>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into a link", element: '<a id="m" href="#x">Go</a>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into a block link", element: '<a id="m" href="#x" style="display: block">Go</a>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into a label", element: '<label id="m">Name</label>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  { name: "two lines into bold text", element: '<b id="m">Bold</b>', text: "Line A\nLine B", html: "Line A<br>Line B" },
  // Two ArrowLeft presses put the caret just before the pasted line break.
  { name: "two lines into a button, then typing before the break", element: '<button id="m">Click</button>', text: "A\nB", keys: ["ArrowLeft", "ArrowLeft"], typed: "X", html: "AX<br>B" },
  // The newline in the source is formatting and stays as it is.
  { name: "two lines after a newline in the source", element: '<button id="m">Click\n  here</button>', end: true, text: "A\nB", html: "Click\n  hereA<br>B" },
  // The paste splits a child block that the element had at the start.
  { name: "two lines at the end of a paragraph in a list item", element: '<ul><li id="m">Title<p class="k">Detail</p></li></ul>', at: { x: 4, y: 4 }, end: true, text: "A\nB", html: 'Title<p class="k">DetailA</p><p class="k">B</p>' },
  { name: "two lines at the end of a child block", element: '<div id="m">Title<div class="k">Detail</div></div>', at: { x: 4, y: 4 }, end: true, text: "A\nB", html: 'Title<div class="k">DetailA</div><div class="k">B</div>' },
];

for (const { name, source: before = "One line", element = `<p id="m">${before}</p>`, at, caret, end, empty, text, keys = [], typed, html, file } of /** @type {{ name: string, source?: string, element?: string, at?: { x: number, y: number }, caret?: number, end?: boolean, empty?: boolean, text: string, keys?: string[], typed?: string, html?: string, file?: string }[]} */ (PASTES)) {
  test(`a clipboard paste of ${name} ${html ? "is queued with line breaks" : "is applied without a newline"}`, async ({ page, project }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const source = boardHtml("Copy", element);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator("#m")).toBeVisible();
    await useTool(page, "edit", ["c.html"]);

    await copy.locator("#m").click(at ? { position: at } : {});
    await expect(copy.locator("#m")).toHaveAttribute("contenteditable", "plaintext-only");
    if (end) await page.keyboard.press(EDIT_END);
    if (caret !== undefined) {
      await page.keyboard.press("Home");
      for (let i = 0; i < caret; i++) await page.keyboard.press("ArrowRight");
    }
    if (empty) {
      await page.keyboard.press("End");
      for (let i = 0; i < before.length; i++) await page.keyboard.press("Backspace");
      await expect(copy.locator("#m")).toHaveText("");
    }
    await copy.locator("#m").evaluate((_, text) => navigator.clipboard.writeText(text), text);
    await page.keyboard.press("ControlOrMeta+V");
    for (const key of keys) await page.keyboard.press(key);
    if (typed) await page.keyboard.type(typed);
    await page.keyboard.press("Enter");

    const item = page.locator(".unsent-item").first();
    if (html) {
      await expect(item.locator(".status")).toHaveText("Not applied: queued for the agent");
      const [stored] = await unsentItems(page);
      expect(stored.newHtml).toBe(html);
      expect(await project.read("c.html")).toBe(source);
    } else {
      await expect(item.locator(".status")).toHaveText("In the file");
      await expect.poll(() => project.read("c.html")).toBe(source.replace(element, file ?? ""));
    }
  });
}

test("undo after a paste of lines removes the paste and keeps the typing before it", async ({ page, project }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await project.create({ "canvas.json": INDEX, "c.html": boardHtml("Copy", '<p id="m">One line</p>') });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#m")).toBeVisible();
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#m").click();
  await page.keyboard.type("Start");
  await copy.locator("#m").evaluate((_, text) => navigator.clipboard.writeText(text), "A\nB\nC");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(copy.locator("#m")).toHaveText("StartABC");

  // One paste can take a few undo steps. Undo must reach the typed text
  // before it reaches the text from before the typing.
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ControlOrMeta+Z");
    const now = await copy.locator("#m").textContent();
    seen.push(now);
    if (now === "Start" || now === "One line") break;
  }
  console.log("undo steps:", JSON.stringify(seen));
  expect(seen.at(-1)).toBe("Start");
});

test("an edit of text that the source wraps over lines is applied", async ({ page, project }) => {
  const source = boardHtml("Copy", '<p id="f">Hello\n  world</p>');
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#f")).toBeVisible();
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#f").click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").filter({ hasText: "world!" }).locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).not.toBe(source);
  expect(await project.read("c.html")).toContain("world!</p>");
});

test("retyping an image button's label keeps the image", async ({ page, project }) => {
  const img = '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22/%3E" alt="">';
  const source = boardHtml("Copy", `<button id="del">${img} Remove</button>`);
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#del")).toHaveText("Remove");
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#del").click();
  await page.keyboard.type("Delete");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").filter({ hasText: "Delete" }).locator(".status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toBe(source.replace(" Remove</button>", " Delete</button>"));
  await expect(copy.locator("#del img")).toHaveCount(1);
});

test("a click on an icon edits the text it sits in", async ({ page, project }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const source = boardHtml("Copy", `<button id="g">Go ${ICON} now</button>`);
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#g")).toHaveText("Go  now");
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#g svg").click();
  await expect(copy.locator("#g")).toHaveAttribute("contenteditable", "plaintext-only");
  // The button's text spans the icon, so the edit selects all of it and the
  // paste replaces the icon too.
  await copy.locator("#g").evaluate(() => navigator.clipboard.writeText("Start"));
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.type(" here");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").filter({ hasText: "Start here" }).locator(".status")).toHaveText("Not applied: queued for the agent");
  const [stored] = await unsentItems(page);
  expect(stored).toMatchObject({ oldText: "Go  now", newText: "Start here", newHtml: "Start here" });
  expect(await project.read("c.html")).toBe(source);
});

test("an edit of an element a script made carries no source position and is queued without reading the file", async ({ page, project }) => {
  const source = boardHtml("Copy", `<ul id="list"><li>Static</li></ul>
<script>const li = document.createElement("li"); li.id = "made"; li.textContent = "Made"; document.getElementById("list").append(li)</script>`);
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#made")).toHaveText("Made");
  await useTool(page, "edit", ["c.html"]);
  /** @type {string[]} */
  const requests = [];
  page.on("request", (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));

  await copy.locator("#made").click();
  await page.keyboard.type("Done");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").filter({ hasText: "Done" }).locator(".status")).toHaveText("Not applied: queued for the agent");
  await expect(page.locator("#hint")).toHaveText("A script made or copied this element, so its place in c.html is not known. The edit is queued for the agent.");
  expect(requests.filter((r) => r.endsWith("/c.html") || r.endsWith("/edit"))).toEqual([]);
  const [stored] = await unsentItems(page);
  expect(stored).toMatchObject({ selector: "#made", oldText: "Made", newText: "Done", src: null, ver: (await served(page, "c.html", "#list")).ver });
  expect(await project.read("c.html")).toBe(source);
});

const SOURCE_POSITIONS = [
  {
    name: "a <template> clone carries the template element's position",
    body: `<template id="row"><li>Pending</li></template><ul id="list"></ul>
<script>document.getElementById("list").append(document.getElementById("row").content.cloneNode(true))</script>`,
    target: "#list li",
    file: "li",
    inTemplate: true,
  },
  {
    name: "one of two <template> clones carries the template element's position",
    body: `<template id="row"><li>Pending</li></template><ul id="list"></ul>
<script>for (let i = 0; i < 2; i++) document.getElementById("list").append(document.getElementById("row").content.cloneNode(true))</script>`,
    target: "#list li:nth-child(2)",
    file: "li",
    inTemplate: true,
  },
  {
    name: "a static row after a row a script added carries its own position",
    body: `<ul id="list"><li>One</li><li>Two</li></ul>
<script>const li = document.createElement("li"); li.textContent = "New"; document.getElementById("list").prepend(li)</script>`,
    target: "#list li:nth-child(2)",
    file: "#list li:first-child",
  },
];

for (const { name, body, target, file, inTemplate } of /** @type {{ name: string, body: string, target: string, file: string, inTemplate?: true }[]} */ (SOURCE_POSITIONS)) {
  test(`an edit of ${name}`, async ({ page, project }) => {
    await project.create({ "canvas.json": INDEX, "c.html": boardHtml("Copy", body) });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator(target)).toBeVisible();
    const expected = await served(page, "c.html", file);
    expect(expected.src).toEqual(expect.any(Number));
    await useTool(page, "edit", ["c.html"]);

    await copy.locator(target).click();
    await page.keyboard.type("Done");
    await page.keyboard.press("Enter");

    await expect(page.locator(".unsent-item").filter({ hasText: "Done" })).toBeVisible();
    const [stored] = await unsentItems(page);
    expect(stored).toMatchObject({ newText: "Done", src: expected.src, ver: expected.ver });

    await page.getByRole("button", { name: "Send to agent" }).click();
    const feedback = await project.wait();
    expect(feedback.items[0]).toMatchObject({ src: expected.src });
    if (inTemplate) expect(feedback.items[0]).toHaveProperty("inTemplate", true);
    else expect(feedback.items[0]).not.toHaveProperty("inTemplate");
  });
}

for (const which of ["#c1", "#c2"]) {
  test(`an edit of ${which === "#c1" ? "a static element that a script copied" : "a script's copy of a static element"} carries no source position and is queued`, async ({ page, project }) => {
    const source = boardHtml("Copy", `<div class="card" id="c1"><p class="title">Plan</p></div>
<script>const copy = document.getElementById("c1").cloneNode(true); copy.id = "c2"; document.body.append(copy)</script>`);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator("#c2 .title")).toHaveText("Plan");
    await useTool(page, "edit", ["c.html"]);
    /** @type {string[]} */
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST") posts.push(new URL(r.url()).pathname); });

    await copy.locator(`${which} .title`).click();
    await page.keyboard.type("Done");
    await page.keyboard.press("Enter");

    await expect(page.locator(".unsent-item").filter({ hasText: "Done" }).locator(".status")).toHaveText("Not applied: queued for the agent");
    await expect(page.locator("#hint")).toHaveText("A script made or copied this element, so its place in c.html is not known. The edit is queued for the agent.");
    expect(posts).toEqual([]);
    const [stored] = await unsentItems(page);
    expect(stored).toMatchObject({ oldText: "Plan", newText: "Done", src: null });
    expect(await project.read("c.html")).toBe(source);
  });
}

// In a button or a table cell a pasted line break is a "\n" character. After
// an undo removes the paste, what is left is a plain edit.
const PASTE_UNDO = [
  { name: "an undo", element: '<button id="m">Click</button>', typed: "Go", keys: ["ControlOrMeta+Z"], file: '<button id="m">Go</button>' },
  { name: "an undo and a redo with Ctrl+Shift+Z", element: '<button id="m">Click</button>', typed: "Go", keys: ["ControlOrMeta+Z", "ControlOrMeta+Shift+Z"], file: '<button id="m">Go</button>' },
  { name: "an undo and a redo with Ctrl+Y", element: '<button id="m">Click</button>', typed: "Go", keys: ["ControlOrMeta+Z", "Control+Y"], file: '<button id="m">Go</button>' },
  { name: "an undo and a redo in a table cell", element: '<table><tr><td id="m">Cell</td></tr></table>', typed: "X", keys: ["ControlOrMeta+Z", "ControlOrMeta+Shift+Z"], file: '<table><tr><td id="m">X</td></tr></table>' },
  { name: "select-all and typing over it", element: '<button id="m">Click</button>', keys: ["ControlOrMeta+A"], after: "Done", file: '<button id="m">Done</button>' },
];

for (const { name, element, typed, keys, after, file } of /** @type {{ name: string, element: string, typed?: string, keys: string[], after?: string, file: string }[]} */ (PASTE_UNDO)) {
  test(`a paste of lines followed by ${name} is applied as a plain edit`, async ({ page, project }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const source = boardHtml("Copy", element);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator("#m")).toBeVisible();
    await useTool(page, "edit", ["c.html"]);

    await copy.locator("#m").click();
    await expect(copy.locator("#m")).toHaveAttribute("contenteditable", "plaintext-only");
    if (typed) await page.keyboard.type(typed);
    await copy.locator("#m").evaluate(() => navigator.clipboard.writeText("A\nB"));
    await page.keyboard.press("ControlOrMeta+V");
    await expect(copy.locator("#m")).toContainText("B");
    for (const key of keys) await page.keyboard.press(key);
    if (typed) await expect(copy.locator("#m")).toHaveText(typed);
    if (after) await page.keyboard.type(after);
    await page.keyboard.press("Enter");

    await expect(page.locator(".unsent-item").first().locator(".status")).toHaveText("In the file");
    await expect.poll(() => project.read("c.html")).toBe(source.replace(element, file));
  });
}

/**
 * Drops text from outside the page at the right edge of the target.
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} target
 * @param {string} text
 */
async function dropText(page, target, text) {
  const box = await target.boundingBox();
  if (!box) throw new Error("no box");
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [{ mimeType: "text/plain", data: text }], dragOperationsMask: 1 };
  const at = { x: box.x + box.width - 3, y: box.y + box.height / 2, data };
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, ...at });
}

// A "\n" can come back without the paste that tracked it: by an undo after
// the pasted break was deleted, or by a redo in the next edit. The edit is
// queued, and newHtml shows the line break as a <br>.
/** @typedef {string | { type: string } | { paste: string } | { drop: string } | "click"} Step */
// Replaces the source newline after "Click" with "-": a click selects the
// text, Ctrl+Home goes to its start, and the shifted arrow selects the
// newline, which shows as one space.
const SOURCE_DASH = [EDIT_START, ...Array(5).fill("ArrowRight"), "Shift+ArrowRight", { type: "-" }];
const UNTRACKED = [
  { name: "an undo after an ArrowLeft and Backspace", steps: [{ type: "Go" }, { paste: "A\nB" }, "ArrowLeft", "Backspace", "ControlOrMeta+Z"], html: "GoA<br>B" },
  { name: "an undo after select-all and Delete", steps: [{ type: "Go" }, { paste: "A\nB" }, "ControlOrMeta+A", "Delete", "ControlOrMeta+Z"], html: "GoA<br>B" },
  { name: "an undo after two Backspaces", steps: [{ type: "Go" }, { paste: "A\nB" }, "Backspace", "Backspace", "ControlOrMeta+Z"], html: "GoA<br>B" },
  { name: "a redo in the next edit", steps: [EDIT_END, { paste: "A\nB" }, "ControlOrMeta+Z", "Escape", "click", "ControlOrMeta+Shift+Z"], html: "Click<br>B" },
  // The newline from the file stays a newline.
  { name: "a redo after a newline in the source", button: "Click\n  here", steps: [EDIT_END, { paste: "A\nB" }, "ControlOrMeta+Z", "Escape", "click", "ControlOrMeta+Shift+Z"], html: "Click\n  here<br>B" },
  // A newline from the file that is deleted in the same edit does not make
  // room for an added one.
  { name: "a drop after typing over a wrapped paragraph", element: '<p id="m">Long sentence that\n  continues here.</p>', steps: [{ type: "Short" }, { drop: "L1\nL2" }], html: "ShortL1<br>L2" },
  { name: "a drop after typing over a wrapped button label", button: "Click\n  here", steps: [{ type: "Go" }, { drop: "L1\nL2" }], html: "GoL1<br>L2" },
  // The undo goes back to the text after the paste, when the source newline
  // was already deleted, so the "\n" it brings back is the pasted break.
  { name: "an undo after the source newline was deleted and a pasted break removed", button: "Click\n  here", steps: [EDIT_END, { type: "Q" }, EDIT_START, ...Array(5).fill("ArrowRight"), "Delete", { paste: "\nB" }, "Backspace", "Backspace", "ControlOrMeta+Z"], html: "Click<br>B  hereQ" },
  // The undo removes only the Z. The dropped "\n" was there before it, so it
  // does not take the place of the deleted source newline.
  { name: "a drop after the source newline was deleted, then an undo of typing", button: "Click\n  here", steps: [EDIT_START, ...Array(5).fill("ArrowRight"), "Delete", { drop: "L1\nL2" }, { type: "Z" }, "ControlOrMeta+Z"], html: "Click  hereL1<br>L2" },
  // The changed part runs from the X to the drop, around the source newline.
  { name: "a drop after typing before a newline in the source", button: "Click\n  here", steps: [EDIT_START, { type: "X" }, { drop: "L1\nL2" }], html: "XClick\n  hereL1<br>L2" },
  { name: "an undo, with the source newline replaced", button: "Click\n  here", steps: [EDIT_END, { paste: "A\nB" }, "ArrowLeft", "Backspace", "ControlOrMeta+Z", ...SOURCE_DASH], html: "Click-  hereA<br>B" },
  { name: "a redo, with the source newline replaced", button: "Click\n  here", steps: [EDIT_END, { paste: "A\nB" }, "ControlOrMeta+Z", "Escape", "click", "ControlOrMeta+Shift+Z", ...SOURCE_DASH], html: "Click-  here<br>B" },
];

for (const { name, button = "Click", element = `<button id="m">${button}</button>`, steps, html } of /** @type {{ name: string, button?: string, element?: string, steps: Step[], html: string }[]} */ (UNTRACKED)) {
  test(`a line break that comes back by ${name} is queued as a <br>`, async ({ page, project }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const source = boardHtml("Copy", element);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator("#m")).toBeVisible();
    await useTool(page, "edit", ["c.html"]);

    await copy.locator("#m").click();
    await expect(copy.locator("#m")).toHaveAttribute("contenteditable", "plaintext-only");
    for (const step of steps) {
      if (step === "click") {
        await expect(copy.locator("#m")).not.toHaveAttribute("contenteditable");
        await copy.locator("#m").click();
        await expect(copy.locator("#m")).toHaveAttribute("contenteditable", "plaintext-only");
      } else if (typeof step === "string") await page.keyboard.press(step);
      else if ("type" in step) await page.keyboard.type(step.type);
      else if ("drop" in step) await dropText(page, copy.locator("#m"), step.drop);
      else {
        await copy.locator("#m").evaluate((_, text) => navigator.clipboard.writeText(text), step.paste);
        await page.keyboard.press("ControlOrMeta+V");
        await expect(copy.locator("#m")).toContainText("B");
      }
    }
    await expect(copy.locator("#m")).toContainText(/B|L2/);
    await page.keyboard.press("Enter");

    await expect(page.locator(".unsent-item").first().locator(".status")).toHaveText("Not applied: queued for the agent");
    const [stored] = await unsentItems(page);
    expect(stored.newHtml).toBe(html);
    expect(await project.read("c.html")).toBe(source);
  });
}

test("a drop of two lines of text into an edit is queued with a <br>", async ({ page, project }) => {
  const source = boardHtml("Copy", '<button id="m">Click</button>');
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await expect(copy.locator("#m")).toBeVisible();
  await useTool(page, "edit", ["c.html"]);

  await copy.locator("#m").click();
  await expect(copy.locator("#m")).toHaveAttribute("contenteditable", "plaintext-only");
  await dropText(page, copy.locator("#m"), "L1\nL2");
  await expect(copy.locator("#m")).toContainText("L2");
  await page.keyboard.press("Enter");

  await expect(page.locator(".unsent-item").first().locator(".status")).toHaveText("Not applied: queued for the agent");
  const [stored] = await unsentItems(page);
  expect(stored.newHtml).toBe("ClickL1<br>L2");
  expect(await project.read("c.html")).toBe(source);
});

// An undo puts a deleted source newline back as a new "\n" character. The
// edit is then the same as the file, so nothing is queued or written.
const SOURCE_UNDO = [
  { name: "a Delete in a button", element: '<button id="m">Click\n  here</button>', keys: [EDIT_START, ...Array(5).fill("ArrowRight"), "Delete", "ControlOrMeta+Z"] },
  { name: "typing over it in a button", element: '<button id="m">Click\n  here</button>', keys: [EDIT_START, ...Array(5).fill("ArrowRight"), "Shift+ArrowRight", "-", "ControlOrMeta+Z"] },
  { name: "typing over the selected paragraph", element: '<p id="m">Long sentence that\n  continues here.</p>', keys: ["X", "ControlOrMeta+Z"] },
  { name: "a Backspace in a paragraph", element: '<p id="m">Long sentence that\n  continues here.</p>', keys: [EDIT_START, ...Array(19).fill("ArrowRight"), "Backspace", "ControlOrMeta+Z"] },
  { name: "typing over the selected paragraph, then typing at the end", element: '<p id="m">Long sentence that\n  continues here.</p>', keys: ["X", "ControlOrMeta+Z", EDIT_END, "Y"], file: '<p id="m">Long sentence that\n  continues here.Y</p>' },
  // Typing before the undo means the text is not back as it was at the start.
  { name: "typing over the paragraph after typing at its end", element: '<p id="m">Long sentence that\n  continues here.</p>', keys: [EDIT_END, "Y", "ControlOrMeta+A", "X", "ControlOrMeta+Z"], file: '<p id="m">Long sentence that\n  continues here.Y</p>' },
  { name: "typing over the start of a button after typing at its end", element: '<button id="m">Click\n  here</button>', keys: [EDIT_END, "Q", EDIT_START, ...Array(6).fill("Shift+ArrowRight"), "G", "o", "ControlOrMeta+Z"], file: '<button id="m">Click\n  hereQ</button>' },
  { name: "typing over two source newlines after typing at the end", element: '<p id="m">Long sentence that\n  continues here\n  and more.</p>', keys: [EDIT_END, "Y", EDIT_START, ...Array(18).fill("ArrowRight"), ...Array(18).fill("Shift+ArrowRight"), "-", "ControlOrMeta+Z"], file: '<p id="m">Long sentence that\n  continues here\n  and more.Y</p>' },
  { name: "typing over two newlines in a row after typing at the end", element: '<p id="m">ab\n\ncd</p>', keys: [EDIT_END, "Y", "ControlOrMeta+A", "X", "ControlOrMeta+Z"], file: '<p id="m">ab\n\ncdY</p>' },
];

for (const { name, element, keys, file } of /** @type {{ name: string, element: string, keys: string[], file?: string }[]} */ (SOURCE_UNDO)) {
  test(`an undo of a source newline removed by ${name} keeps it a source newline`, async ({ page, project }) => {
    const source = boardHtml("Copy", element);
    await project.create({ "canvas.json": INDEX, "c.html": source });
    await page.goto(await project.open());
    await expect(page.locator("#conn")).toHaveText("Live");
    const copy = boardFrame(page, "c.html");
    await expect(copy.locator("#m")).toBeVisible();
    await useTool(page, "edit", ["c.html"]);

    await copy.locator("#m").click();
    await expect(copy.locator("#m")).toHaveAttribute("contenteditable", "plaintext-only");
    for (const key of keys) await page.keyboard.press(key);
    await page.keyboard.press("Enter");
    await expect(copy.locator("#m")).not.toHaveAttribute("contenteditable");

    if (file) {
      await expect(page.locator(".unsent-item").first().locator(".status")).toHaveText("In the file");
      await expect.poll(() => project.read("c.html")).toBe(source.replace(element, file));
    } else {
      // Another edit after it shows that the first one has reached the shell.
      await copy.locator("#m").click();
      await page.keyboard.press(EDIT_END);
      await page.keyboard.type("Z");
      await page.keyboard.press("Enter");
      await expect(page.locator(".unsent-item")).toHaveCount(1);
      await expect(page.locator(".unsent-item .status")).toHaveText("In the file");
      await expect.poll(() => project.read("c.html")).toBe(source.replace(element, element.replace(/(<\/\w+>)$/, "Z$1")));
    }
  });
}

test("full undo after cutting and pasting a cell newline queues nothing", async ({ page, project }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const source = boardHtml("Copy", '<table><tbody><tr><td id="m">Total\n  due</td></tr></tbody></table>');
  await project.create({ "canvas.json": INDEX, "c.html": source });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const copy = boardFrame(page, "c.html");
  await useTool(page, "edit", ["c.html"]);
  await copy.locator("#m").click();
  await page.keyboard.press(EDIT_START);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press(SELECT_TO_END);
  await page.keyboard.press("ControlOrMeta+X");
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(copy.locator("#m")).toHaveText("Total\n  due");
  await page.keyboard.press("Enter");
  await expect(copy.locator("#m")).not.toHaveAttribute("contenteditable");
  await copy.locator("#m").click();
  await page.keyboard.press(EDIT_END);
  await page.keyboard.type("Z");
  await page.keyboard.press("Enter");
  await expect(page.locator(".unsent-item")).toHaveCount(1);
  await expect(page.locator(".unsent-item .status")).toHaveText("In the file");
  await expect.poll(() => project.read("c.html")).toBe(source.replace("  due</td>", "  dueZ</td>"));
});
