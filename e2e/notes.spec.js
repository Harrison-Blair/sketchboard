import { test, expect, boardHtml, TWO_BOARDS } from "./fixtures.js";

/** @param {import("./fixtures.js").Project} project */
async function notes(project) {
  return Object.values((await project.index()).notes ?? {});
}

test("a sticky added in the browser is written to canvas.json and a note the agent adds appears in the browser", async ({ page, project }) => {
  await project.create({
    "canvas.json": TWO_BOARDS,
    "a.html": boardHtml("Alpha", "<h1>Alpha heading</h1>"),
    "b.html": boardHtml("Beta", "<h1>Beta heading</h1>"),
  });
  await page.goto(await project.open());
  await expect(page.locator("#conn")).toHaveText("Live");

  await page.getByRole("button", { name: "Add sticky" }).click();
  const sticky = page.getByRole("textbox", { name: "Sticky text" });
  await expect(sticky).toBeFocused();
  await sticky.fill("From the browser");
  await sticky.blur();
  await expect.poll(() => notes(project)).toContainEqual(expect.objectContaining({ kind: "sticky", text: "From the browser" }));

  const before = /** @type {{ x: number }} */ ((await notes(project)).find((n) => n.text === "From the browser"));
  await page.getByRole("button", { name: /^Move sticky/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await notes(project)).find((n) => n.text === "From the browser")?.x).toBe(before.x + 10);

  const index = await project.index();
  index.notes.t9 = { kind: "title", x: 0, y: -160, text: "Agent title" };
  await project.write("canvas.json", index);
  await expect(page.getByRole("textbox", { name: "Title text" })).toHaveValue("Agent title");
  await expect(sticky).toHaveValue("From the browser");

  await page.getByRole("button", { name: "Delete sticky" }).click();
  await expect.poll(() => notes(project)).toEqual([expect.objectContaining({ kind: "title", text: "Agent title" })]);
  await expect(page.getByRole("textbox", { name: "Sticky text" })).toHaveCount(0);
});
