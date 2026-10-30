# Internal protocol

The server listens on `http://127.0.0.1:<port>` (default port 4870). The browser shell and the CLI use these endpoints. `src/protocol.js` defines the request and response types as JSDoc typedefs. It has no Node imports. GET `/__sketchboard/protocol.js` serves the package `src/protocol.js`; UI modules import it as `./protocol.js`. JSON errors return a non-2xx status and `{"error": "..."}`.

The server rejects a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. It rejects a POST whose `Origin` is present and is not the server's own origin.

The server reads a missing `notes`, `compare`, or `order` in `canvas.json` as empty.

| Method | Path | Body → Response | Purpose |
|---|---|---|---|
| GET | `/` | → HTML | Shell page that lists the canvases. |
| GET | `/c/:canvas` | → HTML | Shell page for one canvas; `open` prints this URL. |
| GET | `/__sketchboard/protocol.js` | → JS | Serves the package `src/protocol.js`; UI modules import it as `./protocol.js`. |
| GET | `/__sketchboard/:file` | → JS/CSS | Shell and overlay assets from the package `ui/` folder. |
| GET | `/design/*` | → file | Any file under `design/` except `design/.canvas/`; HTML gets the overlay script injected, and `?raw=1` skips the injection. |
| POST | `/__sketchboard/api/open` | `OpenRequest` → `OpenResponse` | Creates `design/<canvas>/` and an empty `canvas.json` if missing and returns the shell URL. |
| GET | `/__sketchboard/api/canvases` | → `CanvasListResponse` | Lists canvases with held feedback and connected tab counts. |
| GET | `/__sketchboard/api/canvas/:canvas` | → `CanvasIndex` | Returns the parsed `canvas.json`. |
| POST | `/__sketchboard/api/canvas/:canvas/notes` | `NotesRequest` → `NotesResponse` | Adds, replaces, or deletes titles and stickies in `canvas.json` and keeps every other key. |
| GET | `/__sketchboard/api/events?canvas=<name>` | → SSE `ServerEvent` | Streams `board`, `index`, and `system` change events; an open stream counts as a connected tab for the idle stop. |
| POST | `/__sketchboard/api/send` | `SendRequest` → `SendResponse` | Holds a batch of feedback items and an optional message until `wait` reads them. |
| POST | `/__sketchboard/api/edit` | `EditRequest` → `EditResponse` | Applies a text edit to the board file if the old text occurs exactly once and returns the `edit` item for the Unsent queue. |
| GET | `/__sketchboard/api/wait?canvas=<name>&timeout=<s>` | → `WaitOutput` | Long poll that returns held feedback, or waits for Send, or returns `timedOut: true` at the timeout. |
| GET | `/__sketchboard/api/status` | → `StatusResponse` | Returns the URL, project root, pid, canvases, and active `wait` count. |
| POST | `/__sketchboard/api/stop` | → `StopResponse` | Replies, closes all streams, deletes `server.json`, and exits. |

## Idle stop

The server exits after 30 minutes with no open event stream and no `wait` in progress. Held feedback does not keep it alive. The event stream sends a comment line every 15 seconds; a failed write closes that connection.

## State file

`design/.canvas/server.json` holds `ServerState`: `v`, `pid`, `port`, `url`, `root`, and `startedAt`.

## CLI contract

`sketchboard --version` prints the package version and exits. It does not start the server.
