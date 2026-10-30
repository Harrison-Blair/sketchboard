# sketchboard

A local design canvas for coding agents. It serves live-reloading HTML boards on a pan-and-zoom canvas at `127.0.0.1`. You point at elements, add notes, and press Send. Your agent reads the feedback through a CLI. It has no publish step and needs no account.

## Install

Requires Node.js 22 or later.

```sh
npm install -g github:Harrison-Blair/sketchboard
```

## Commands

| Command | What it does |
|---|---|
| `sketchboard open <canvas>` | Start the server if needed, create `design/<canvas>/` if missing, and print the URL. |
| `sketchboard wait [<canvas>] [--timeout <s>]` | Block until you press Send, then print the feedback as JSON. Default timeout: 540 s. |
| `sketchboard status` | Show the server URL, open canvases, and held feedback count. |
| `sketchboard stop` | Stop the server. |
| `sketchboard shot <canvas> <board>` | Save a PNG of one board with a local headless browser. |
| `sketchboard --version` | Print the version and exit. It does not start the server. |

## License

MIT
