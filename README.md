# sketchboard

A local design canvas for coding agents. It serves live-reloading HTML boards on a pan-and-zoom canvas at `127.0.0.1`. You point at elements, add notes, and press Send. Your agent reads the feedback through a CLI. It has no publish step and needs no account.

## Install

Requires Node.js 22 or later. Works on Linux, macOS, and Windows.

```sh
npm install -g github:Harrison-Blair/sketchboard
```

## Storage

All canvases live in one folder, `~/.agents/sketchboard/` (on Windows `%USERPROFILE%\.agents\sketchboard`). Commands work from any folder.

- `<canvas>/canvas.json` and the canvas's HTML boards
- `systems/<name>/`: shared design systems (`systems` is a reserved canvas name)
- `.state/`: server state, log, and screenshots

## Commands

| Command | What it does |
|---|---|
| `sketchboard open <canvas>` | Start the server if needed, create the canvas if missing, and print the URL. |
| `sketchboard wait [<canvas>] [--timeout <s>]` | Block until you press Send, then print the feedback as JSON. There is no timeout unless you give one. The wait ends with `"closed": true` when no browser tab has been open on the canvas (on any canvas, without `<canvas>`) for 30 minutes. |
| `sketchboard locate <canvas> <file>` | Print saved `wait` output (the file holds it, or its `items` array) with the edited elements' positions (`line`, `col`, `tag`) recomputed against the board files now. Run it right before you change a board file. |
| `sketchboard status` | Show the server URL, the canvases, held feedback, and open tabs. |
| `sketchboard stop` | Stop the server. |
| `sketchboard shot <canvas> <board>` | Save a PNG of one board to `.state/shots/<canvas>/` with a local Chrome, Chromium, Edge, or Firefox. |
| `sketchboard --version` | Print the version and exit. It does not start the server. |

The server stops by itself after 30 minutes with no open tab and no `wait`.

## Limits

Boards are served from the same origin as the canvas, so a script that a board loads can call the local API as you: it can send feedback or apply text edits. Open only boards you trust.

## License

MIT
