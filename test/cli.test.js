import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { alive, cleanup, cli, http, makeHome, openEvents, readState, until } from "./helpers.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("--version prints the version and starts no server", async () => {
  const root = makeHome();
  try {
    const r = await cli(root, ["--version"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), pkg.version);
    assert.equal(existsSync(root), false);
  } finally {
    await cleanup(root);
  }
});

test("bad input prints usage and exits non-zero without starting a server", async () => {
  const root = makeHome();
  try {
    for (const args of [[], ["bogus"], ["open"], ["open", "a", "b"], ["wait", "--timeout"], ["wait", "--timeout", "-1"], ["wait", "--nope"], ["shot", "x"]]) {
      const r = await cli(root, args);
      assert.equal(r.code, 2, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /Usage:/);
      assert.equal(r.stdout, "");
    }
    for (const name of ["..", "a/b", "a\\b", "", ".state", "systems", "Systems"]) {
      const r = await cli(root, ["open", name]);
      assert.equal(r.code, 1, `name ${JSON.stringify(name)}`);
      assert.match(r.stderr, /canvas name|reserved/);
    }
    assert.equal(existsSync(root), false);
  } finally {
    await cleanup(root);
  }
});

test("open creates the canvas, ignores tool state, and reuses the server", async () => {
  const root = makeHome();
  try {
    const first = await cli(root, ["open", "home"]);
    assert.equal(first.code, 0, first.stderr);
    const state = readState(root);
    assert.equal(first.stdout.trim().split("\n").at(-1), `http://127.0.0.1:${state.port}/c/home`);
    assert.equal(first.stdout.split("\n")[0], `Created ${path.join(root, "home", "canvas.json")}`);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "home", "canvas.json"), "utf8")), {
      v: 1,
      title: "home",
      boards: {},
      order: [],
      notes: {},
      compare: {},
    });
    assert.equal(readFileSync(path.join(root, ".state", ".gitignore"), "utf8").trim(), "*");
    assert.equal(state.v, 1);
    assert.equal(state.root, root);
    assert.equal(state.url, `http://127.0.0.1:${state.port}`);
    assert.ok(alive(state.pid));

    const second = await cli(root, ["open", "home"]);
    assert.equal(second.code, 0);
    assert.equal(second.stdout.trim(), `http://127.0.0.1:${state.port}/c/home`);
    assert.equal(readState(root).pid, state.pid);
  } finally {
    await cleanup(root);
  }
});

test("concurrent opens start one server", async () => {
  const root = makeHome();
  try {
    const results = await Promise.all(["a", "b", "c", "d"].map((c) => cli(root, ["open", c])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const state = readState(root);
    const ports = results.map((r) => new URL(r.stdout.trim().split("\n").at(-1) ?? "").port);
    assert.deepEqual(new Set(ports), new Set([String(state.port)]));
    const status = (await http(state.port, "GET", "/__sketchboard/api/status")).json();
    assert.equal(status.pid, state.pid);
    assert.equal(status.canvases.length, 4);
  } finally {
    await cleanup(root);
  }
});

test("a stale server.json (dead pid or no answer) is replaced", async () => {
  const root = makeHome();
  try {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    const closed = await freePort();
    for (const pid of [dead, process.pid]) {
      mkdirSync(path.join(root, ".state"), { recursive: true });
      const stale = { v: 1, pid, port: closed, url: `http://127.0.0.1:${closed}`, root, startedAt: "2020-01-01T00:00:00.000Z" };
      writeFileSync(path.join(root, ".state", "server.json"), JSON.stringify(stale));
      const r = await cli(root, ["open", "home"]);
      assert.equal(r.code, 0, r.stderr);
      const state = readState(root);
      assert.notEqual(state.pid, pid);
      assert.ok(alive(state.pid));
      await cli(root, ["stop"]);
    }
  } finally {
    await cleanup(root);
  }
});

test("stop deletes server.json and ends the process; stop without a server starts none", async () => {
  const root = makeHome();
  try {
    await cli(root, ["open", "home"]);
    const { pid } = readState(root);
    const r = await cli(root, ["stop"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Stopped/);
    assert.equal(existsSync(path.join(root, ".state", "server.json")), false);
    await until(() => !alive(pid));
    const again = await cli(root, ["stop"]);
    assert.match(again.stdout, /No sketchboard server is running/);
    assert.equal(existsSync(path.join(root, ".state", "server.json")), false);
  } finally {
    await cleanup(root);
  }
});

test("status starts the server and prints readable text", async () => {
  const root = makeHome();
  try {
    await cli(root, ["open", "home"]);
    const r = await cli(root, ["status"]);
    assert.equal(r.code, 0);
    const { port, pid } = readState(root);
    assert.match(r.stdout, new RegExp(`Server: http://127\\.0\\.0\\.1:${port} \\(pid ${pid}\\)`));
    assert.match(r.stdout, /home {2}"home" {2}held 0, tabs 0/);
  } finally {
    await cleanup(root);
  }
});

test("wait prints only WaitOutput JSON", async () => {
  const root = makeHome();
  try {
    await cli(root, ["open", "home"]);
    const { port } = readState(root);

    const timedOut = await cli(root, ["wait", "home", "--timeout", "0.2"]);
    assert.equal(timedOut.code, 0);
    assert.deepEqual(JSON.parse(timedOut.stdout), { canvas: "home", items: [], timedOut: true });

    const any = await cli(root, ["wait", "--timeout=0.2"]);
    assert.deepEqual(JSON.parse(any.stdout), { canvas: null, items: [], timedOut: true });

    const item = { kind: "pin", board: "a.html", x: 1, y: 2, selector: "h1", tag: "h1", text: "Hi", note: "bigger" };
    const pending = cli(root, ["wait", "home", "--timeout", "30"]);
    await until(async () => (await http(port, "GET", "/__sketchboard/api/status")).json().waiting === 1);
    await http(port, "POST", "/__sketchboard/api/send", { body: { canvas: "home", items: [item], message: "thanks" } });
    const got = await pending;
    assert.equal(got.code, 0, got.stderr);
    assert.deepEqual(JSON.parse(got.stdout), { canvas: "home", items: [item, { kind: "message", text: "thanks" }] });

    await http(port, "POST", "/__sketchboard/api/send", { body: { canvas: "home", items: [item] } });
    const heldNow = await cli(root, ["wait"]);
    assert.deepEqual(JSON.parse(heldNow.stdout), { canvas: "home", items: [item] });

    // newHtml is raw HTML and passes through unchanged.
    const edit = {
      kind: "edit", board: "a.html", selector: "p", oldText: "$12/mo", newText: "$15/mo", applied: false,
      newHtml: '$<span class="n">15</span>/mo &amp; <b>"tax" \u2192 \u{1F44B}</b>\n<br>',
    };
    await http(port, "POST", "/__sketchboard/api/send", { body: { canvas: "home", items: [edit] } });
    const withHtml = await cli(root, ["wait"]);
    assert.equal(withHtml.stdout, JSON.stringify({ canvas: "home", items: [edit] }) + "\n");
  } finally {
    await cleanup(root);
  }
});

test("idle stop: exits when idle, stays up while a stream is open, and after a wait ends", async () => {
  const root = makeHome();
  const env = { SKETCHBOARD_IDLE_MS: "400" };
  try {
    await cli(root, ["open", "home"], env);
    let { pid, port } = readState(root);

    const stream = await openEvents(port, "home");
    await sleep(900);
    assert.ok(alive(pid), "an open event stream keeps the server up");
    stream.close();
    await until(() => !alive(pid));
    assert.equal(existsSync(path.join(root, ".state", "server.json")), false);

    await cli(root, ["open", "home"], env);
    ({ pid, port } = readState(root));
    // A wait with no tab closes after the idle time (tested below); a shorter --timeout ends it first.
    const waiting = await cli(root, ["wait", "home", "--timeout", "0.2"], env);
    assert.deepEqual(JSON.parse(waiting.stdout), { canvas: "home", items: [], timedOut: true });
    assert.ok(alive(pid), "the server is still up after the wait times out");

    await http(port, "POST", "/__sketchboard/api/send", { body: { canvas: "home", items: [{ kind: "message", text: "x" }] } });
    await until(() => !alive(pid));
    assert.equal(existsSync(path.join(root, ".state", "server.json")), false);
  } finally {
    await cleanup(root);
  }
});

test("wait without --timeout blocks until feedback is sent", async () => {
  const root = makeHome();
  try {
    await cli(root, ["open", "home"]);
    const { port } = readState(root);
    let done = false;
    const pending = cli(root, ["wait", "home"]).finally(() => (done = true));
    await sleep(1500);
    assert.equal(done, false, "wait returned before any feedback");
    await http(port, "POST", "/__sketchboard/api/send", { body: { canvas: "home", items: [], message: "go" } });
    const got = await pending;
    assert.equal(got.code, 0, got.stderr);
    assert.deepEqual(JSON.parse(got.stdout), { canvas: "home", items: [{ kind: "message", text: "go" }] });
  } finally {
    await cleanup(root);
  }
});

test("wait closes after the idle time with no tab on its canvas, then the server stops", async () => {
  const root = makeHome();
  const env = { SKETCHBOARD_IDLE_MS: "1500" };
  // A safety net far past the idle time: if the close rule breaks, a wait returns timedOut instead of hanging.
  const guard = ["--timeout", "10"];
  try {
    await cli(root, ["open", "home"], env);
    await cli(root, ["open", "other"], env);
    const { pid, port, startedAt } = readState(root);
    await http(port, "POST", "/__sketchboard/api/send", { body: { canvas: "other", items: [], message: "kept" } });

    // A tab on another canvas does not keep a wait for "home" open.
    const otherTab = await openEvents(port, "other");
    // "home" never had a tab, so the count runs from server start.
    const closed = await cli(root, ["wait", "home", ...guard], env);
    const sinceStart = Date.now() - Date.parse(startedAt);
    assert.equal(closed.code, 0, closed.stderr);
    assert.deepEqual(JSON.parse(closed.stdout), { canvas: "home", items: [], closed: true });
    assert.ok(sinceStart >= 1400 && sinceStart < 4000, `closed ${sinceStart} ms after server start`);
    let started = Date.now();

    // A tab on the wait's canvas keeps it open; the countdown starts when that tab closes.
    const homeTab = await openEvents(port, "home");
    let done = false;
    const pending = cli(root, ["wait", "home", ...guard], env).finally(() => (done = true));
    await sleep(2500);
    assert.equal(done, false, "an open tab on the canvas keeps the wait open");
    homeTab.close();
    started = Date.now();
    const afterTab = await pending;
    assert.deepEqual(JSON.parse(afterTab.stdout), { canvas: "home", items: [], closed: true });
    assert.ok(Date.now() - started >= 1400, "the countdown starts when the last tab closes");

    // Without a canvas, a tab on any canvas keeps the wait open. Feedback held for "other" would end it, so take it first.
    const kept = await cli(root, ["wait", "other"], env);
    assert.deepEqual(JSON.parse(kept.stdout), { canvas: "other", items: [{ kind: "message", text: "kept" }] }, "closing a wait keeps held feedback");
    done = false;
    const anyWait = cli(root, ["wait", ...guard], env).finally(() => (done = true));
    await sleep(2500);
    assert.equal(done, false, "a tab on any canvas keeps a wait without a canvas open");
    otherTab.close();
    started = Date.now();
    const anyClosed = await anyWait;
    assert.deepEqual(JSON.parse(anyClosed.stdout), { canvas: null, items: [], closed: true });
    assert.ok(Date.now() - started >= 1400, "the count for a wait without a canvas starts when the last tab on any canvas closes");

    // No tab and no other request during the idle time: the server stops promptly, not one more idle time later.
    await until(() => !alive(pid), 1000).catch(() => assert.fail("the server did not stop promptly after the wait closed"));
  } finally {
    await cleanup(root);
  }
});

test("a loop of short waits closes once the canvas has had no tab for the idle time", async () => {
  const root = makeHome();
  const env = { SKETCHBOARD_IDLE_MS: "1500" };
  /**
   * Runs `wait home --timeout 0.4` until it closes; returns the number of timed-out waits before that.
   * @param {() => Promise<unknown>} [between] Other activity after each wait.
   */
  const loop = async (between) => {
    for (let n = 0; n < 15; n++) {
      const r = await cli(root, ["wait", "home", "--timeout", "0.4"], env);
      const out = JSON.parse(r.stdout);
      if (out.closed) {
        assert.deepEqual(out, { canvas: "home", items: [], closed: true });
        return n;
      }
      assert.deepEqual(out, { canvas: "home", items: [], timedOut: true });
      await between?.();
    }
    assert.fail("no wait in the loop returned closed");
  };
  try {
    await cli(root, ["open", "home"], env);
    const { pid, port } = readState(root);
    // Other requests keep the server up after this close, but do not count as a tab.
    const other = () => http(port, "GET", "/__sketchboard/api/canvases");
    assert.ok((await loop(other)) >= 1, "the first waits time out before the idle time passes");

    // Once the canvas has had no tab for the idle time, a new wait closes at once.
    const started = Date.now();
    const again = await cli(root, ["wait", "home", "--timeout", "5"], env);
    assert.deepEqual(JSON.parse(again.stdout), { canvas: "home", items: [], closed: true });
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);

    // A tab opened and closed restarts the count.
    const tab = await openEvents(port, "home");
    await sleep(200);
    tab.close();
    const closedAt = Date.now();
    assert.ok((await loop()) >= 1, "waits after the tab closed time out until the idle time passes");
    assert.ok(Date.now() - closedAt >= 1400, "the count restarted when the tab closed");

    // The loop's waits and status probes do not hold off the idle stop.
    await until(() => !alive(pid), 1000).catch(() => assert.fail("the server did not stop promptly after the loop closed"));
  } finally {
    await cleanup(root);
  }
});

test("open gives a canvas a fresh idle time on a server that has run longer than that", async () => {
  const root = makeHome();
  const env = { SKETCHBOARD_IDLE_MS: "1500" };
  try {
    await cli(root, ["open", "a"], env);
    const { port } = readState(root);
    // A tab on another canvas keeps the server up past the idle time.
    const tab = await openEvents(port, "a");
    try {
      await sleep(2000);
      await cli(root, ["open", "b"], env);
      const opened = Date.now();
      const r = await cli(root, ["wait", "b", "--timeout", "10"], env);
      const took = Date.now() - opened;
      assert.deepEqual(JSON.parse(r.stdout), { canvas: "b", items: [], closed: true });
      assert.ok(took >= 1400 && took < 4000, `closed ${took} ms after open`);

      // open during a pending wait restarts that wait's count.
      await cli(root, ["open", "b"], env);
      const pending = cli(root, ["wait", "b", "--timeout", "10"], env);
      await sleep(800);
      await cli(root, ["open", "b"], env);
      const reopened = Date.now();
      assert.deepEqual(JSON.parse((await pending).stdout), { canvas: "b", items: [], closed: true });
      assert.ok(Date.now() - reopened >= 1400, `closed ${Date.now() - reopened} ms after the second open`);
    } finally {
      tab.close();
    }

    // A wait without a canvas also counts from the last open. Other requests keep the server up meanwhile.
    for (let i = 0; i < 7; i++) {
      await sleep(300);
      await http(port, "GET", "/__sketchboard/api/canvases");
    }
    await cli(root, ["open", "b"], env);
    const opened = Date.now();
    const any = await cli(root, ["wait", "--timeout", "10"], env);
    assert.deepEqual(JSON.parse(any.stdout), { canvas: null, items: [], closed: true });
    assert.ok(Date.now() - opened >= 1400, `a wait without a canvas closed ${Date.now() - opened} ms after open`);
  } finally {
    await cleanup(root);
  }
});

/** @returns {Promise<number>} a port that nothing listens on */
function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}
