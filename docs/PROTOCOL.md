# Internal protocol

The server listens on `http://127.0.0.1:<port>` (default port 4870). The browser shell and the CLI use these endpoints. `src/protocol.js` defines the request and response types as JSDoc typedefs. It has no Node imports. GET `/__sketchboard/protocol.js` serves the package `src/protocol.js`; UI modules import it as `./protocol.js`. JSON errors return a non-2xx status and `{"error": "..."}`.

The server rejects a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. It rejects a POST whose `Origin` is present and is not the server's own origin.
It rejects a request to `/__sketchboard/api/*` whose `Sec-Fetch-Site` is present and is not `same-origin` or `none`. The CLI sends no `Origin` and no `Sec-Fetch-*` headers.
Known v1 limit: boards are served from the shell's origin, so a script that a board loads can call the API as the user. For example, it can send feedback or apply edits.

The server reads a missing `notes`, `compare`, or `order` in `canvas.json` as empty.

| Method | Path | Body → Response | Purpose |
|---|---|---|---|
| GET | `/` | → HTML | Shell page that lists the canvases. |
| GET | `/c/:canvas` | → HTML | Shell page for one canvas; `open` prints this URL. |
| GET | `/__sketchboard/protocol.js` | → JS | Serves the package `src/protocol.js`; UI modules import it as `./protocol.js`. |
| GET | `/__sketchboard/:file` | → JS/CSS | Shell and overlay assets from the package `ui/` folder. |
| GET | `/design/*` | → file | Any file in the root folder except `<root>/.state/`; HTML gets the overlay script injected, and `?raw=1` skips the injection. |
| POST | `/__sketchboard/api/open` | `OpenRequest` → `OpenResponse` | Creates `<root>/<canvas>/` and an empty `canvas.json` if missing and returns the shell URL. |
| GET | `/__sketchboard/api/canvases` | → `CanvasListResponse` | Lists canvases with held feedback and connected tab counts. |
| GET | `/__sketchboard/api/canvas/:canvas` | → `CanvasIndex` | Returns the parsed `canvas.json`. |
| POST | `/__sketchboard/api/canvas/:canvas/notes` | `NotesRequest` → `NotesResponse` | Adds, replaces, or deletes titles and stickies in `canvas.json` and keeps every other key. |
| GET | `/__sketchboard/api/events?canvas=<name>` | → SSE `ServerEvent` | Streams `board`, `index`, and `system` change events; an open stream counts as a connected tab for the idle stop. |
| POST | `/__sketchboard/api/send` | `SendRequest` → `SendResponse` | Holds a batch of feedback items and an optional message until `wait` reads them. |
| POST | `/__sketchboard/api/edit` | `EditRequest` → `EditResponse` | Applies a text edit to the board file under the hybrid edit rule (below) and returns the `edit` item for the Unsent queue. |
| GET | `/__sketchboard/api/wait?canvas=<name>&timeout=<s>` | → `WaitOutput` | Long poll that returns held feedback, or waits for Send. Both query parameters are optional. With `timeout`, it returns `timedOut: true` at the timeout; there is no default timeout. It returns `closed: true` when no tab has been open for 30 minutes (see Idle stop). |
| GET | `/__sketchboard/api/status` | → `StatusResponse` | Returns the URL, root folder, pid, canvases, and active `wait` count. |
| POST | `/__sketchboard/api/stop` | → `StopResponse` | Replies, closes all streams, deletes `server.json`, and exits. |

## Hybrid edit rule

The server applies an edit only if exactly one visible text run of the board, decoded and trimmed, equals `oldText`, and `oldText` occurs nowhere in `<script>` content. Otherwise it returns `applied: false` and does not change the file.

- A visible text run is the text between two tags. Text inside tags (so attribute values), comments, and the contents of `<script>`, `<style>`, `<title>`, `<template>`, `<noscript>`, and `<textarea>` is not visible text.
- If the request has a numeric `src` and a `ver` with the same element ordinals as the current file (see Source positions), the run must also be a direct text child of the element with ordinal `src`: not text of another element, and not text of a descendant element. Otherwise, or if `src` is null or missing, only the text rule applies.
- The whole trimmed run must equal `oldText`. A match inside a longer run does not count, because the overlay sends an element's whole trimmed `textContent`. Text that crosses a tag, such as `$<span>12</span>/mo`, never matches.
- Trimming removes leading and trailing whitespace as JavaScript's `String.prototype.trim` does, which includes no-break spaces.
- Decoding makes visible text compare like the DOM's `textContent`. Decimal (`&#8594;`) and hexadecimal (`&#x2192;`) references are decoded; 0, surrogates, and values above U+10FFFF become U+FFFD. These named references are decoded: `amp lt gt quot apos nbsp mdash ndash hellip rarr larr uarr darr copy reg trade middot bull rsquo lsquo rdquo ldquo times deg euro pound`. A reference needs its `;`. Other named references stay literal text. CRLF and CR become LF. No other whitespace changes.
- `<script>` content is checked both as written and decoded, because a script can insert either form as HTML.
- The server replaces the exact source text of the trimmed run, including any references in it, with `newText`. Whitespace around it stays as written. It writes `&`, `<`, and `>` in `newText` as `&amp;`, `&lt;`, and `&gt;`.
- An `edit` item with `applied: false` can carry an optional `newHtml`: the edited element's inner HTML as the user left it in the live page. It is raw HTML, not escaped, and does not include the element's own tag and attributes. The browser fills it; `send` holds it and `wait` returns it unchanged. The server never writes it to a file. An applied edit has no `newHtml`.

## Source positions

When the server serves a board HTML page with the overlay (not with `?raw=1`, and not under `/design/systems/`), it adds attributes to the page. It never writes them to a file. A board script that reads `innerHTML` or `outerHTML` gets the `data-sb-src` attributes too.

- `data-sb-src="N"` on every element start tag. N is the 0-based ordinal of that start tag in the file, in source order. The count includes every element start tag (also `<script>`, `<style>`, `<title>`, `<textarea>`, `<noscript>`, void and self-closing tags, and SVG children) and the tags inside `<template>` content. It excludes tags in comments and in the raw-text contents of `<script>`, `<style>`, `<title>`, `<textarea>`, and `<noscript>`. A `>` inside a quoted attribute value does not end a tag. Elements that a script creates have no `data-sb-src`; a clone copies the attribute of its source.
- `data-sb-ver="<hash>"` on the injected overlay `<script>` tag. The hash is the first 16 hexadecimal characters of the SHA-256 of the file's exact bytes.

The browser sends the edited element's ordinal as `src` (null if it has no `data-sb-src`) and the page's hash as `ver` in an `EditRequest`. The returned `edit` item keeps both. `send` adds fields to each `edit` item that has a `ver` and a numeric `src`:

- If the page version `ver` has the same element ordinals as the current file: `line`, the 1-based line where start tag `src` begins (CRLF, CR, and LF each end a line); `tag`, that start tag exactly as in the file, cut to 200 characters; and `inTemplate: true` if the element is inside a `<template>`.
- Otherwise, or if the file is gone: `fileChanged: true`, and no `line` or `tag`.

`send` adds nothing to items with `src: null` or without `ver`, and keeps every other field unchanged.

A version has the same element ordinals as the current file if its hash equals the file's current hash, or if only edits that the server applied changed the file since that version. An applied edit changes only text between tags, so the ordinals stay the same. `line` and `tag` always come from the current file. The server forgets those earlier versions when any other change reaches the file (for example, the agent saves it), and keeps at most the last 100 per board. Pages under `/design/systems/` get neither attribute: the overlay `<script>` tag has no `data-sb-ver`.

## Idle stop

The server exits after 30 minutes with no open event stream and no `wait` in progress. Held feedback does not keep it alive.

A `wait` ends with `{"canvas": "<name>", "items": [], "closed": true}` when no tab (event stream) has been open on its canvas for 30 minutes. For a `wait` without a canvas, the rule uses tabs on any canvas, and `canvas` is null. The server tracks when each canvas, and any canvas, last had a tab open or was last opened with `open`, across waits. The 30 minutes count from the later of those times, or from server start if there was neither. So a loop of short `wait --timeout` calls still ends with `closed`, and a wait that starts after 30 minutes without a tab or an `open` closes at once. Held feedback stays held. After a wait closes, the idle-stop countdown counts from the last request or closed tab. `wait` and `status` requests do not count, so with no other activity in that time the server stops right after the reply. The event stream sends a comment line every 15 seconds; a failed write closes that connection.

## State file

`<root>/.state/server.json` holds `ServerState`: `v`, `pid`, `port`, `url`, `root`, and `startedAt`. `<root>/.state/` also holds `server.log`, the start lock, `shots/<canvas>/<board>.png`, and a `.gitignore` that contains `*`.

## CLI contract

`sketchboard --version` prints the package version and exits. It does not start the server.

One server serves every canvas. All canvases live in one root folder, `~/.agents/sketchboard/` (on Windows `%USERPROFILE%\.agents\sketchboard`), and commands work from any current folder. Layout: `<root>/<canvas>/canvas.json` and the canvas's board files; shared design systems in `<root>/systems/<name>/`; tool state in `<root>/.state/`. `systems` is a reserved canvas name. URLs map `/design/` to the root. The environment variable `SKETCHBOARD_HOME` overrides the root folder; it exists for tests.
Two more variables exist only for tests: `SKETCHBOARD_IDLE_MS` sets the server's idle-stop time in milliseconds (default 30 minutes), and `SKETCHBOARD_SHOT_TIMEOUT_MS` sets the time in milliseconds before `shot` stops a browser run (default 60 000).
