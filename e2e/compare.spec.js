import { test, expect, boardHtml, TWO_BOARDS } from "./fixtures.js";

test("compare picks and aspect choices reach wait as pick and mix items", async ({ page, project }) => {
  await project.create({
    "canvas.json": { ...TWO_BOARDS, compare: { look: { boards: ["a.html", "b.html"], aspects: ["color", "type"] } } },
    "a.html": boardHtml("Alpha", "<h1>Alpha heading</h1>"),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  await page.getByRole("button", { name: /^look/ }).click();
  await expect(page.getByRole("heading", { name: "Compare: look" })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Compare board: Alpha"]').locator("h1")).toHaveText("Alpha heading");
  await expect(page.frameLocator('iframe[title="Compare board: Beta"]').locator("h1")).toHaveText("Beta heading");

  await page.getByRole("group", { name: "Pick" }).getByLabel("Beta").check();
  await page.getByRole("group", { name: "color from" }).getByLabel("Alpha").check();
  await page.getByRole("group", { name: "type from" }).getByLabel("Alpha").check();
  await page.getByRole("group", { name: "type from" }).getByLabel("None").check();
  await page.getByRole("group", { name: "color from" }).getByLabel("Beta").check();
  await page.getByRole("group", { name: "color from" }).getByLabel("Alpha").check();
  await expect(page.getByRole("heading", { name: "Unsent (2)" })).toBeVisible();

  await page.getByRole("button", { name: "Close compare" }).click();
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent 2 items" })).toBeVisible();

  const feedback = await project.wait();
  expect(feedback.items).toEqual([
    { kind: "pick", compare: "look", board: "b.html" },
    { kind: "mix", compare: "look", aspect: "color", board: "a.html" },
  ]);
});
