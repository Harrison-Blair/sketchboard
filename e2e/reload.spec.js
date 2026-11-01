import { test, expect, boardHtml, boardFrame, boardFrameHandle, TWO_BOARDS } from "./fixtures.js";

const TALL = '<div style="height: 1200px"></div>';

test("saving a board file reloads only that board's frame and keeps its scroll position", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", `<h1>Alpha heading</h1>${TALL}`),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  await expect(boardFrame(page, "a.html").locator("h1")).toHaveText("Alpha heading");
  await expect(boardFrame(page, "b.html").locator("h1")).toHaveText("Beta heading");
  const alpha = await boardFrameHandle(page, "a.html");
  const beta = await boardFrameHandle(page, "b.html");
  await alpha.evaluate(() => {
    Object.assign(window, { e2eMark: "before" });
    scrollTo(0, 200);
  });
  await beta.evaluate(() => Object.assign(window, { e2eMark: "before" }));

  await project.write("a.html", boardHtml("Alpha", `<h1>Alpha heading v2</h1>${TALL}`));

  await expect(boardFrame(page, "a.html").locator("h1")).toHaveText("Alpha heading v2");
  expect(await alpha.evaluate(() => /** @type {any} */ (window).e2eMark)).toBeUndefined();
  expect(await beta.evaluate(() => /** @type {any} */ (window).e2eMark)).toBe("before");
  await expect.poll(() => alpha.evaluate(() => scrollY)).toBe(200);
});

test("an index change re-lays out the boards and the server-stopped banner appears when the server stops", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", "<h1>Alpha heading</h1>"),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");
  const index = await project.index();
  index.boards["b.html"].title = "Beta, renamed";
  await project.write("canvas.json", index);
  await expect(page.locator(".board-name")).toHaveText(["Alpha", "Beta, renamed"]);

  await project.cli("stop");
  await expect(page.getByRole("alert")).toContainText("sketchboard open e2e");
});
