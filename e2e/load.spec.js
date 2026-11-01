import { test, expect, boardHtml, boardFrame, TWO_BOARDS } from "./fixtures.js";

test("the home page, the shell, and its boards load with no console errors or failed requests", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", "<h1>Alpha heading</h1>"),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  const url = await project.open();
  /** @type {string[]} */
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`failed: ${request.url()} ${request.failure()?.errorText}`));
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });

  await page.goto(new URL("/", url).href);
  await expect(page.getByRole("link", { name: "E2E canvas" })).toBeVisible();

  await page.goto(url);
  await expect(boardFrame(page, "a.html").locator("h1")).toHaveText("Alpha heading");
  await expect(boardFrame(page, "b.html").locator("h1")).toHaveText("Beta heading");
  await expect(page.locator("#conn")).toHaveText("Live");
  await expect(page.locator(".board-name")).toHaveText(["Alpha", "Beta"]);
  expect(problems).toEqual([]);
});
