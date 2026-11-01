import { test, expect, boardHtml, boardFrame, boardFrameHandle, useTool, TWO_BOARDS } from "./fixtures.js";

test("a board that follows a link to a page that is not a board returns to its own board, and feedback names that board", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", '<h1>Alpha heading</h1><p><a id="go" href="extra.html">Extra page</a></p>'),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
    "extra.html": boardHtml("Extra", "<h1>Not a board</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");

  await alpha.locator("#go").click();
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await expect.poll(async () => (await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);

  await useTool(page, "element", ["a.html"]);
  await alpha.locator("h1").click();
  await page.getByLabel(/^Note on/).fill("Here");
  await page.getByRole("button", { name: "Add to Unsent" }).click();
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 1 item" })).toBeVisible();
  const feedback = await project.wait();
  expect(feedback.items).toEqual([expect.objectContaining({ kind: "element", board: "a.html", text: "Alpha heading" })]);
});

test("a board sent to another origin returns to its board", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", "<h1>Alpha heading</h1>"),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  await expect(boardFrame(page, "a.html").locator("h1")).toHaveText("Alpha heading");

  // localhost and 127.0.0.1 are different origins, so the shell cannot read
  // this frame's location. No internet access is needed.
  const away = page.waitForEvent("framenavigated", (f) => f.url().startsWith("http://localhost:"));
  const alpha = await boardFrameHandle(page, "a.html");
  await alpha.evaluate(() => {
    location.href = location.href.replace("127.0.0.1", "localhost").replace(/a\.html$/, "b.html");
  });
  await away;

  await expect.poll(async () => (await boardFrameHandle(page, "a.html")).url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/design\/e2e\/a\.html$/);
  await expect(boardFrame(page, "a.html").locator("h1")).toHaveText("Alpha heading");
});

/**
 * Distance in px from the board frame's centre to the canvas centre. Fit
 * leaves room for the name strip above the frame, so a centred board sits
 * about half a strip (15 px) below the canvas centre.
 * @param {import("@playwright/test").Page} page
 * @param {string} board
 */
async function offCentre(page, board) {
  const view = await page.locator("#viewport").boundingBox();
  const frame = await page.locator(`.board[data-board="${board}"] iframe`).boundingBox();
  if (!view || !frame) throw new Error("no box");
  return Math.max(
    Math.abs(frame.x + frame.width / 2 - (view.x + view.width / 2)),
    Math.abs(frame.y + frame.height / 2 - (view.y + view.height / 2)),
  );
}

test("a link to another board pans the canvas to that board and leaves the frame on its own board", async ({ page, context, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>
<p><a id="pricing" href="b.html">Pricing</a></p>
<p><a id="pricing-tab" href="./b.html#plans" target="_blank">Pricing in a new tab</a></p>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await expect(boardFrame(page, "b.html").locator("h1")).toHaveText("Beta heading");
  expect(await offCentre(page, "b.html")).toBeGreaterThan(100);

  await alpha.locator("#pricing").click();
  await expect.poll(() => offCentre(page, "b.html")).toBeLessThanOrEqual(20);
  expect((await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");

  await page.getByRole("button", { name: "Fit all" }).click();
  expect(await offCentre(page, "b.html")).toBeGreaterThan(100);
  await alpha.locator("#pricing-tab").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => offCentre(page, "b.html")).toBeLessThanOrEqual(20);
  expect(context.pages()).toHaveLength(1);
  expect((await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);
});

test("an image-map area that points to another board pans to that board and leaves the frame on its own board", async ({ page, project }) => {
  const map = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40'/%3E";
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>
<img id="map" src="${map}" width="120" height="40" usemap="#m" alt="Map"><map name="m"><area shape="rect" coords="0,0,120,40" href="b.html" alt="Pricing"></map>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await expect(boardFrame(page, "b.html").locator("h1")).toHaveText("Beta heading");
  expect(await offCentre(page, "b.html")).toBeGreaterThan(100);

  await alpha.locator("#map").click();
  await expect.poll(() => offCentre(page, "b.html")).toBeLessThanOrEqual(20);
  expect((await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
});

test("a link within the board scrolls the board and leaves the canvas view alone", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>
<p><a id="to-x" href="#x">Jump to features</a></p>
<div style="height: 2000px"></div>
<h2 id="x">Features</h2>
<p><a id="to-top" href="#">Back to top</a></p>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await expect(page.locator("#conn")).toHaveText("Live");
  const world = page.locator("#world");
  const before = await world.getAttribute("style");
  const frame = await boardFrameHandle(page, "a.html");

  await alpha.locator("#to-x").click();
  await expect.poll(() => frame.evaluate(() => scrollY)).toBeGreaterThan(1000);
  expect(frame.url()).toMatch(/\/a\.html#x$/);
  expect(await world.getAttribute("style")).toBe(before);

  await alpha.locator("#to-top").click();
  await expect.poll(() => frame.evaluate(() => scrollY)).toBe(0);
  expect(await world.getAttribute("style")).toBe(before);
});

test("a board returns from a page without the overlay: a missing file and a form result", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>
<p><a id="later" href="later.html">A board that is not written yet</a></p>
<form method="post" action="/login"><button id="login">Log in</button></form>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");

  for (const id of ["#later", "#login"]) {
    const left = page.waitForEvent("framenavigated", (f) => !/\/a\.html$/.test(f.url()) && f.parentFrame() === page.mainFrame());
    await alpha.locator(id).click();
    await left;
    await expect.poll(async () => (await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);
    await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  }
});

test("Back leaves the canvas after a board was sent back", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", '<h1>Alpha heading</h1><p><a id="go" href="extra.html">Extra page</a></p>'),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
    "extra.html": boardHtml("Extra", "<h1>Not a board</h1>"),
  });
  const url = await project.open();
  const home = new URL("/", url).href;
  await page.goto(home);
  await page.goto(url);
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");

  await alpha.locator("#go").click();
  await expect.poll(async () => (await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");

  // The link itself added one history entry in the frame, so the first Back
  // stays on the canvas. The return must not add more, so the second leaves.
  // history.back() runs in a timer so that evaluate returns before the page
  // can navigate away.
  const back = () => page.evaluate(() => void setTimeout(() => history.back()));
  const frameBack = page.waitForEvent("framenavigated", (f) => f.parentFrame() === page.mainFrame());
  await back();
  await frameBack;
  expect(page.url()).toBe(url);
  await back();
  await page.waitForURL(home);
});

test("a board that changes its own address with pushState still takes feedback and reloads", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>
<button id="settings" onclick="history.pushState(null, '', 'settings')">Settings</button>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");

  await alpha.locator("#settings").click();
  await expect.poll(async () => (await boardFrameHandle(page, "a.html")).url()).toMatch(/\/settings$/);

  await useTool(page, "element", ["a.html"]);
  await alpha.locator("h1").click();
  await page.getByLabel(/^Note on/).fill("Here");
  await page.getByRole("button", { name: "Add to Unsent" }).click();
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 1 item" })).toBeVisible();
  const feedback = await project.wait();
  expect(feedback.items).toEqual([expect.objectContaining({ kind: "element", board: "a.html", text: "Alpha heading" })]);

  await project.write("a.html", boardHtml("Alpha", "<h1>Alpha heading v2</h1>"));
  await expect(alpha.locator("h1")).toHaveText("Alpha heading v2");
  expect((await boardFrameHandle(page, "a.html")).url()).toMatch(/\/a\.html$/);
});

test("a board that leaves as soon as it loads is sent back at most 3 times, then says so until its file is saved", async ({ page, project }) => {
  const gate = `<script>if (!localStorage.getItem("user")) location.href = "signup.html";</script>`;
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `${gate}<h1>Alpha heading</h1>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
    "signup.html": boardHtml("Sign up", "<h1>Sign up</h1>"),
  });
  let loads = 0;
  page.on("request", (request) => {
    if (/\/design\/e2e\/a\.html$/.test(request.url())) loads++;
  });
  await page.goto(await project.open());
  const stuck = page.locator('.board[data-board="a.html"] .stuck');
  await expect(stuck).toHaveText("Alpha keeps navigating away when it loads. Save the file to try again.");
  await page.waitForTimeout(1000);
  expect(loads).toBeLessThanOrEqual(4);

  await project.write("a.html", boardHtml("Alpha", "<h1>Alpha fixed</h1>"));
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha fixed");
  await expect(stuck).toHaveCount(0);
});

test("a board script that calls history.back() does not leave the canvas", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>
<button id="back" onclick="history.back()">Back</button>
<button id="go" onclick="history.go(-1)">Go back</button>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  const url = await project.open();
  await page.goto(new URL("/", url).href);
  await page.goto(url);
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await expect(page.locator("#conn")).toHaveText("Live");

  await alpha.locator("#back").click();
  await alpha.locator("#go").click();
  await page.waitForTimeout(1000);
  expect(page.url()).toBe(url);
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
});

/**
 * Resolves when the board frame is back on its board and its overlay has run.
 * @param {import("@playwright/test").Frame} frame
 */
async function backOnBoard(frame) {
  await expect.poll(
    () => frame.evaluate(() => location.pathname.endsWith("/a.html") && document.readyState === "complete").catch(() => false),
    { intervals: [20] },
  ).toBe(true);
}

const MAP_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40'/%3E";
const QUICK_CLICKS = [
  { name: "a link to a missing page", html: '<a id="go" href="missing.html">Missing page</a>', click: "#go" },
  { name: "a button whose script sets location.href", html: `<button id="go" onclick="location.href = 'missing.html'">Checkout</button>`, click: "#go" },
  { name: "a link whose script cancels it and sets location.href", html: '<a id="go" href="missing.html" onclick="event.preventDefault(); location.href = this.href">Checkout</a>', click: "#go" },
  { name: "an image-map area", html: `<img id="go" src="${MAP_IMAGE}" width="120" height="40" usemap="#m" alt="Map"><map name="m"><area shape="rect" coords="0,0,120,40" href="missing.html" alt="Checkout"></map>`, click: "#go" },
  { name: "a button whose script goes to a page that takes 1.5 s to answer", html: `<button id="go" onclick="location.href = 'slow.html'">Sign in</button>`, click: "#go", away: "slow.html" },
];

for (const { name, html, click, away: target = "missing.html" } of QUICK_CLICKS) {
  test(`quick clicks on ${name} never mark the board stuck`, async ({ page, project }) => {
    await project.create({
      "canvas.json": TWO_BOARDS,
      "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1><p>${html}</p>`),
      "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
    });
    await page.goto(await project.open());
    const alpha = boardFrame(page, "a.html");
    await expect(alpha.locator("h1")).toHaveText("Alpha heading");
    const frame = await boardFrameHandle(page, "a.html");
    await page.route("**/slow.html", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ contentType: "text/html", body: "<h1>Sign in</h1>" });
    });

    for (let i = 0; i < 6; i++) {
      await backOnBoard(frame);
      const away = page.waitForEvent("framenavigated", (f) => f === frame && f.url().endsWith(`/${target}`));
      await alpha.locator(click).click();
      await away;
    }
    await backOnBoard(frame);
    await page.waitForTimeout(500);
    await expect(page.locator(".stuck")).toHaveCount(0);
    await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  });
}

test("a board that redirects by itself after 2 s is marked stuck", async ({ page, project }) => {
  test.setTimeout(30000);
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1><script>setTimeout(() => { location.href = "signup.html"; }, 2000);</script>`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
    "signup.html": boardHtml("Sign up", "<h1>Sign up</h1>"),
  });
  await page.goto(await project.open());
  await expect(page.locator('.board[data-board="a.html"] .stuck')).toHaveText(/keeps navigating away/, { timeout: 15000 });
});

test("a board with a meta refresh to another page is marked stuck", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", '<meta http-equiv="refresh" content="0;url=signup.html"><h1>Alpha heading</h1>'),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
    "signup.html": boardHtml("Sign up", "<h1>Sign up</h1>"),
  });
  await page.goto(await project.open());
  await expect(page.locator('.board[data-board="a.html"] .stuck')).toHaveText(/keeps navigating away/, { timeout: 10000 });
});
