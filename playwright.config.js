import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: {
    viewport: { width: 1600, height: 1000 },
  },
});
