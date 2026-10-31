import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBrowser } from "../src/shot.js";
import { alive, cleanup, cli, makeHome, until } from "./helpers.js";

const posix = process.platform !== "win32";

/** @param {string[]} names */
function binDir(names) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sketchboard-bin-"));
  for (const n of names) writeFileSync(path.join(dir, n), "", { mode: 0o755 });
  return dir;
}

test("findBrowser prefers Chromium-family browsers, falls back to Firefox, and returns null", { skip: !posix && "PATH layout test uses POSIX paths" }, () => {
  const both = binDir(["firefox", "chromium"]);
  const fox = binDir(["firefox"]);
  const none = binDir([]);
  try {
    assert.deepEqual(findBrowser({ PATH: both }, "linux"), { kind: "chromium", path: path.join(both, "chromium") });
    assert.deepEqual(findBrowser({ PATH: fox }, "linux"), { kind: "firefox", path: path.join(fox, "firefox") });
    assert.equal(findBrowser({ PATH: none }, "linux"), null);
  } finally {
    for (const d of [both, fox, none]) rmSync(d, { recursive: true, force: true });
  }
});

test("shot without a browser prints a clear error and exits non-zero", { skip: process.platform !== "linux" && "standard install paths exist outside PATH" }, async () => {
  const root = makeHome();
  const none = binDir([]);
  try {
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: none });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no browser found/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(none, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot retries Chromium with --no-sandbox on Linux when the first run writes no PNG", { skip: process.platform !== "linux" && "the retry is Linux-only" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  // A stand-in for Chromium: logs its arguments and writes the screenshot only with --no-sandbox.
  const log = path.join(bin, "args.log");
  writeFileSync(
    path.join(bin, "chromium"),
    `#!/bin/sh
echo "$*" >> "${log}"
case " $* " in *" --no-sandbox "*) ;; *) exit 1 ;; esac
for a in "$@"; do case "$a" in --screenshot=*) printf 'png' > "\${a#--screenshot=}" ;; esac; done
`,
    { mode: 0o755 },
  );
  try {
    const canvas = path.join(root, "home");
    mkdirSync(canvas, { recursive: true });
    writeFileSync(path.join(canvas, "a.html"), "<p>a</p>");
    writeFileSync(path.join(canvas, "canvas.json"), JSON.stringify({ v: 1, title: "Home", boards: { "a.html": { x: 0, y: 0, w: 320, h: 200, title: "A" } } }));
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(root, ".state", "shots", "home", "a.png"));
    const runs = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(runs.length, 2);
    assert.doesNotMatch(runs[0], /--no-sandbox/, "the first run keeps the sandbox");
    assert.match(runs[1], /^--no-sandbox .*--window-size=320,200/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot does not hang when a browser leaves a child process holding its output open", { skip: process.platform !== "linux" && "uses a POSIX shell stand-in" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  const pidFile = path.join(bin, "child.pid");
  // Like Firefox's crash reporter: a background child keeps stdout and stderr open after the browser exits.
  writeFileSync(
    path.join(bin, "chromium"),
    `#!/bin/sh
for a in "$@"; do case "$a" in --screenshot=*) printf 'png' > "\${a#--screenshot=}" ;; esac; done
/bin/sleep 10 &
echo $! > "${pidFile}"
exit 0
`,
    { mode: 0o755 },
  );
  try {
    const canvas = path.join(root, "home");
    mkdirSync(canvas, { recursive: true });
    writeFileSync(path.join(canvas, "a.html"), "<p>a</p>");
    writeFileSync(path.join(canvas, "canvas.json"), JSON.stringify({ v: 1, title: "Home", boards: { "a.html": { x: 0, y: 0, w: 320, h: 200, title: "A" } } }));
    const started = Date.now();
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - started < 5000, `shot took ${Date.now() - started} ms`);
    const leftover = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(leftover), 2000).catch(() => assert.fail("the leftover child process is still running"));
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")));
    } catch {
      // Already gone.
    }
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot timeout kills the whole browser process tree and deletes the temp profile", { skip: process.platform !== "linux" && "uses a POSIX shell stand-in" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  const info = path.join(bin, "info");
  // A browser that never finishes and has a background child, like a hung browser with a crash reporter.
  writeFileSync(
    path.join(bin, "chromium"),
    `#!/bin/sh
for a in "$@"; do case "$a" in --user-data-dir=*) echo "profile \${a#--user-data-dir=}" >> "${info}" ;; esac; done
echo "pid $$" >> "${info}"
/bin/sleep 60 &
echo "pid $!" >> "${info}"
exec /bin/sleep 61
`,
    { mode: 0o755 },
  );
  /** @type {number[]} */
  let pids = [];
  try {
    const canvas = path.join(root, "home");
    mkdirSync(canvas, { recursive: true });
    writeFileSync(path.join(canvas, "a.html"), "<p>a</p>");
    writeFileSync(path.join(canvas, "canvas.json"), JSON.stringify({ v: 1, title: "Home", boards: { "a.html": { x: 0, y: 0, w: 320, h: 200, title: "A" } } }));
    const started = Date.now();
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin, SKETCHBOARD_SHOT_TIMEOUT_MS: "500" });
    assert.ok(Date.now() - started < 10_000, `shot took ${Date.now() - started} ms`);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /timed out after 0\.5 s/);
    const lines = readFileSync(info, "utf8").trim().split("\n");
    pids = lines.filter((l) => l.startsWith("pid ")).map((l) => Number(l.slice(4)));
    assert.equal(pids.length, 4, "two runs (the Linux --no-sandbox retry) of two processes each");
    await until(() => pids.every((p) => !alive(p)), 2000).catch(() => assert.fail(`still running: ${pids.filter(alive)}`));
    const profiles = lines.filter((l) => l.startsWith("profile ")).map((l) => l.slice(8));
    assert.equal(profiles.length, 2);
    for (const p of profiles) assert.equal(existsSync(p), false, `temp profile ${p} was not deleted`);
  } finally {
    for (const p of pids) {
      try {
        process.kill(p);
      } catch {
        // Already gone.
      }
    }
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

/**
 * A stand-in Firefox that counts its runs and writes the screenshot only from run `okFrom` on.
 * @param {string} bin
 * @param {number} okFrom
 */
function fakeFirefox(bin, okFrom) {
  const count = path.join(bin, "count");
  writeFileSync(
    path.join(bin, "firefox"),
    `#!/bin/sh
n=0; [ -f "${count}" ] && read n < "${count}"
n=$((n + 1)); echo $n > "${count}"
[ $n -lt ${okFrom} ] && exit 3
prev=""; for a in "$@"; do [ "$prev" = "--screenshot" ] && printf 'png' > "$a"; prev="$a"; done
exit 0
`,
    { mode: 0o755 },
  );
  return () => Number(readFileSync(count, "utf8"));
}

/** @param {string} root */
function writeBoard(root) {
  const canvas = path.join(root, "home");
  mkdirSync(canvas, { recursive: true });
  writeFileSync(path.join(canvas, "a.html"), "<p>a</p>");
  writeFileSync(path.join(canvas, "canvas.json"), JSON.stringify({ v: 1, title: "Home", boards: { "a.html": { x: 0, y: 0, w: 320, h: 200, title: "A" } } }));
}

test("shot retries Firefox once and says so on stderr", { skip: process.platform !== "linux" && "uses a POSIX shell stand-in" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  const runs = fakeFirefox(bin, 2);
  try {
    writeBoard(root);
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(runs(), 2);
    assert.equal(r.stderr, "sketchboard: Firefox wrote no screenshot (exit 3); retrying once\n");
    assert.equal(r.stdout.trim(), path.join(root, ".state", "shots", "home", "a.png"));
  } finally {
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot reports a clear error when the Firefox retry also fails", { skip: process.platform !== "linux" && "uses a POSIX shell stand-in" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  const runs = fakeFirefox(bin, 99);
  try {
    writeBoard(root);
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin });
    assert.equal(r.code, 1);
    assert.equal(runs(), 2);
    assert.match(r.stderr, /retrying once\n/);
    assert.match(r.stderr, /firefox did not write a screenshot \(exit 3\)/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot on a listed board whose file is missing fails without starting a browser", { skip: process.platform !== "linux" && "uses a POSIX shell stand-in" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  const log = path.join(bin, "ran");
  writeFileSync(
    path.join(bin, "chromium"),
    `#!/bin/sh
echo ran >> "${log}"
for a in "$@"; do case "$a" in --screenshot=*) printf 'png' > "\${a#--screenshot=}" ;; esac; done
`,
    { mode: 0o755 },
  );
  try {
    writeBoard(root);
    rmSync(path.join(root, "home", "a.html"));
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `sketchboard: board file ${path.join(root, "home", "a.html")} does not exist\n`);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(log), false, "the browser was started");
    assert.equal(existsSync(path.join(root, ".state", "shots", "home", "a.png")), false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot succeeds when the temporary profile cannot be deleted", { skip: (process.platform !== "linux" || process.getuid?.() === 0) && "uses a POSIX shell stand-in and file modes" }, async () => {
  const root = makeHome();
  const bin = binDir([]);
  const info = path.join(bin, "profile");
  // Like a Windows crash handler that still holds the profile: leave a folder that cannot be emptied.
  // PATH holds only the stand-in, so the script calls tools by full path.
  writeFileSync(
    path.join(bin, "chromium"),
    `#!/bin/sh
for a in "$@"; do case "$a" in
  --screenshot=*) printf 'png' > "\${a#--screenshot=}" ;;
  --user-data-dir=*) p="\${a#--user-data-dir=}"; echo "$p" > "${info}"; /bin/mkdir "$p/held"; /bin/touch "$p/held/lock"; /bin/chmod 555 "$p/held" ;;
esac; done
`,
    { mode: 0o755 },
  );
  try {
    writeBoard(root);
    const r = await cli(root, ["shot", "home", "a.html"], { PATH: bin });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(root, ".state", "shots", "home", "a.png"));
    assert.match(r.stderr, /^sketchboard: could not delete the temporary profile .*sketchboard-shot-/);
  } finally {
    if (existsSync(info)) {
      const profile = readFileSync(info, "utf8").trim();
      if (existsSync(path.join(profile, "held"))) chmodSync(path.join(profile, "held"), 0o755);
      rmSync(profile, { recursive: true, force: true });
    }
    rmSync(bin, { recursive: true, force: true });
    await cleanup(root);
  }
});

test("shot writes a PNG at the board size", { skip: !findBrowser() && "no browser on this machine", timeout: 120_000 }, async () => {
  const root = makeHome();
  try {
    const canvas = path.join(root, "home");
    mkdirSync(canvas, { recursive: true });
    writeFileSync(path.join(canvas, "a.html"), '<!doctype html><body style="margin:0;background:#e11d48"><h1>Shot</h1></body>');
    writeFileSync(path.join(canvas, "canvas.json"), JSON.stringify({ v: 1, title: "Home", boards: { "a.html": { x: 0, y: 0, w: 640, h: 360, title: "A" } } }));
    const r = await cli(root, ["shot", "home", "a.html"]);
    assert.equal(r.code, 0, r.stderr);
    const out = r.stdout.trim();
    assert.equal(out, path.join(root, ".state", "shots", "home", "a.png"));
    const png = readFileSync(out);
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 360]);

    const missing = await cli(root, ["shot", "home", "nope.html"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not in/);
  } finally {
    await cleanup(root);
  }
});
