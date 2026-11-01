import { test, expect, boardHtml, boardFrame, boardFrameHandle, useTool, waitForMode, TWO_BOARDS } from "./fixtures.js";

const ALPHA = `
<h1>Alpha heading</h1>
<p class="lead">Welcome</p>
<div class="actions"><button id="buy">Buy now</button><button>Later</button></div>
<section style="height: 200px"></section>
`;

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} note
 */
async function saveNote(page, note) {
  await page.getByLabel(/^Note on/).fill(note);
  await page.getByRole("button", { name: "Add to Unsent" }).click();
}

test("each pointing tool and Send deliver items with board, selector, text, and note to wait", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", ALPHA),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await expect(page.locator("#zoom-level")).toHaveText("100%");

  await useTool(page, "element", ["a.html"]);
  await alpha.locator("h1").click();
  await saveNote(page, "Make the heading larger");

  await useTool(page, "text", ["a.html"]);
  await alpha.locator("p.lead").dblclick({ position: { x: 10, y: 8 } });
  await saveNote(page, "Friendlier greeting");

  await useTool(page, "pin", ["a.html"]);
  await alpha.locator("#buy").click({ position: { x: 6, y: 5 } });
  await saveNote(page, "Use the brand colour");

  await useTool(page, "circle", ["a.html"]);
  const box = await page.locator('.board[data-board="a.html"] iframe').boundingBox();
  if (!box) throw new Error("no frame box");
  await page.mouse.move(box.x + 40, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 250, { steps: 5 });
  await page.mouse.move(box.x + 240, box.y + 300, { steps: 5 });
  await page.mouse.up();
  await saveNote(page, "Fill this gap");

  await expect(page.getByRole("heading", { name: "Unsent (4)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Interact" })).toHaveAttribute("aria-pressed", "true");
  await waitForMode(page, "none", ["a.html"]);

  await page.getByLabel("Message to agent").fill("Please make these changes");
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 4 items" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unsent (0)" })).toBeVisible();

  const feedback = await project.wait();
  expect(feedback.canvas).toBe("e2e");
  expect(feedback.timedOut).toBeUndefined();
  const [element, text, pin, circle, message] = feedback.items;
  expect(feedback.items).toHaveLength(5);

  expect(element).toMatchObject({ kind: "element", board: "a.html", tag: "h1", text: "Alpha heading", note: "Make the heading larger" });
  expect(text).toMatchObject({ kind: "text", board: "a.html", text: "Welcome", note: "Friendlier greeting" });
  expect(pin).toMatchObject({ kind: "pin", board: "a.html", tag: "button", text: "Buy now", note: "Use the brand colour" });
  expect(circle).toMatchObject({ kind: "circle", board: "a.html", note: "Fill this gap" });
  expect(message).toEqual({ kind: "message", text: "Please make these changes" });

  const frame = await boardFrameHandle(page, "a.html");
  /** @param {string} selector @param {string} expected */
  const resolvesTo = (selector, expected) => frame.evaluate(([s, e]) => {
    const all = document.querySelectorAll(s);
    return all.length === 1 && all[0] === document.querySelector(e);
  }, [selector, expected]);
  expect(await resolvesTo(element.selector, "h1")).toBe(true);
  expect(await resolvesTo(text.selector, "p.lead")).toBe(true);
  expect(await resolvesTo(pin.selector, "#buy")).toBe(true);
  expect(element.selector).toBe("h1");
  expect(pin.selector).toBe("#buy");

  const buy = await frame.evaluate(() => {
    const r = /** @type {Element} */ (document.querySelector("#buy")).getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY };
  });
  expect(Math.abs(pin.x - (buy.x + 6))).toBeLessThanOrEqual(2);
  expect(Math.abs(pin.y - (buy.y + 5))).toBeLessThanOrEqual(2);
  for (const [actual, expected] of [[circle.x, 40], [circle.y, 200], [circle.w, 200], [circle.h, 100]]) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  }
});

test("Unsent items can be removed before Send", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", ALPHA),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  const alpha = boardFrame(page, "a.html");
  await expect(alpha.locator("h1")).toHaveText("Alpha heading");
  await useTool(page, "element", ["a.html"]);
  await alpha.locator("h1").click();
  await saveNote(page, "First");
  await alpha.locator("#buy").click();
  await saveNote(page, "Second");
  await expect(page.getByRole("heading", { name: "Unsent (2)" })).toBeVisible();

  await page.getByRole("button", { name: /^Remove item 1/ }).click();
  await expect(page.getByRole("heading", { name: "Unsent (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 1 item" })).toBeVisible();

  const feedback = await project.wait();
  expect(feedback.items).toEqual([expect.objectContaining({ kind: "element", selector: "#buy", note: "Second" })]);
});
