# Keto tracker — v1 spec

You are the tech lead and the only engineer. Implement this spec. Do not expand scope. Do not redesign the product.

## Product

A private daily keto log that runs in the browser on this Raspberry Pi. Kfir opens it to see today's stats. Any coding agent can insert rows through a tiny stdio MCP server that shares the same database.

This is a new log. Do not read, write, or import the Google Sheet. Do not touch Tailscale, Hermes config, or anything outside this directory plus one systemd user unit.

## Hard constraints

- Python 3.11 stdlib only. No pip, npm, Docker, Node, or third-party packages.
- Bind `127.0.0.1:8787` only. Never `0.0.0.0`.
- SQLite file: `/home/kfir/dev/keto/data/keto.sqlite` (create `data/`, gitignore the db and wal/shm).
- "Today" is `Europe/Copenhagen`.
- Dates in the UI and MCP are `DD/MM/YYYY`. Store ISO `YYYY-MM-DD` internally.
- Food names and notes are stored verbatim. Hebrew must round-trip and render correctly (RTL on those fields, LTR chrome).
- Net-carb goal is 20 g. Show remaining and whether the day is over the goal.
- One daily total is computed, never stored as a row.
- No auth in v1. Loopback only.
- No emoji, no illustrations, no "welcome to your journey" copy, no purple gradients, no Inter, no card-in-card dashboard chrome.

## Data

Table `entries`:

- `id` integer primary key
- `entry_date` text `YYYY-MM-DD` not null
- `entry_time` text `HH:MM` or null
- `fasting_hours` real or null (only on the row that breaks a fast)
- `item` text not null
- `quantity` text or null
- `calories` real or null
- `fat_g` real or null
- `protein_g` real or null
- `net_carbs_g` real not null (0 is allowed)
- `notes` text or null
- `meal` text or null
- `source` text not null (`ui` or `mcp`)
- `created_at` text ISO-8601 not null

Totals for a day are the sum of numeric columns. Blank numbers are skipped, not treated as zero, except `net_carbs_g` which is always present.

Reject an entry whose item is empty or whose net carbs are missing/not a number.

## HTTP

Stdlib server. One process.

- `GET /` serves the single-page UI.
- `GET /api/day?date=DD/MM/YYYY` returns entries plus totals, goal `20`, remaining carbs, and `over_goal`. Missing date means today.
- `POST /api/entries` accepts one object or a list. Fields: `date`, `time`, `fasting_hours`, `item`, `quantity`, `calories`, `fat_g`, `protein_g`, `net_carbs_g`, `notes`, `meal`. `source` is set by the server to `ui`. Returns the created rows and the updated day summary.
- `GET /api/recent?n=14` returns one summary object per day, newest first.
- JSON errors with a clear `error` string and a 4xx status. No stack traces to the client.

## UI

One page. Mobile-first, because it will be opened from a phone later. System font stack only, so it works offline:

`Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif` for the hero number.
`ui-sans-serif, system-ui, sans-serif` for labels and the form.

Palette:

- paper `#f4f1ea`
- ink `#1c1917`
- muted `#78716c`
- line `#e7e5e4`
- under goal `#3f6212`
- over goal `#9a3412`

Layout:

- Top: date as `DD/MM/YYYY`, previous/next day, a control that jumps to today.
- Hero: net carbs as a large number, then `/ 20 g`, then a 4px bar. Color follows under/over goal.
- Quiet secondary line: kcal, fat g, protein g, fasting hours if any row has them.
- Entry list, chronological, grouped by `meal` when set, otherwise a single list. Each row: time, item, quantity, the four numbers, notes. Hebrew items use `dir="auto"`.
- Add form under the list: item, quantity, net carbs, calories, fat, protein, time (default now), meal, fasting hours, notes. Item and net carbs required. Submit on Enter from the item field. After save, clear item/quantity/notes and refresh the day. Do not clear the date.
- Empty day: the sentence `No entries.` Nothing else.

No settings page. No charts. No accounts.

## MCP

`mcp_server.py` speaks MCP over stdio (JSON-RPC 2.0, Content-Length framing). Implement only what a coding agent needs:

- `initialize` / `initialized`
- `tools/list`
- `tools/call`
- `ping`

Tools, same validation as HTTP:

- `add_entries` — argument `entries`: array of the same fields as `POST /api/entries`. Server sets `source` to `mcp`. Returns created rows and the day summary for each touched date.
- `get_day` — argument `date` (`DD/MM/YYYY`, optional, default today). Same payload as `GET /api/day`.
- `recent_days` — argument `n` optional, default 14, max 60.

No resources, no prompts, no sampling. Log MCP stderr only; stdout is the protocol.

Document, in `README.md`, the exact stdio command:

`/usr/bin/python3 /home/kfir/dev/keto/mcp_server.py`

and a Claude Code `claude mcp add` example plus a generic MCP config JSON block. Do not register the server into Hermes or Claude yourself.

## Process

- `server.py` is the web process. `python3 server.py` listens on `127.0.0.1:8787`.
- Shared DB access must be safe for the web process and the MCP process at the same time (`timeout`, WAL).
- User unit file written into the repo as `keto.service` and installed at `~/.config/systemd/user/keto.service`.
- `systemctl --user daemon-reload && systemctl --user enable --now keto.service`
- If systemd fails, leave the unit file and say so. Do not use sudo. Do not touch linger.
- Do not run `tailscale`.

## Repo

`/home/kfir/dev/keto`

Expected files: `SPEC.md` (do not rewrite), `README.md`, `db.py`, `server.py`, `mcp_server.py`, `static/index.html`, `static/app.css`, `static/app.js`, `check.py`, `keto.service`, `.gitignore`.

`check.py` must be runnable with the server stopped or started; it uses a temp database via an env var `KETO_DB` and does not touch `data/keto.sqlite`. It checks:

- insert + day totals
- Hebrew item round-trip
- reject empty item
- reject missing net carbs
- MCP `initialize`, `tools/list`, and `add_entries` against the temp db (spawn the server as a subprocess or call the handler directly if stdio framing is covered by at least one framed exchange)

`git init` if needed. One commit after `check.py` passes. No remote, no push.

## Done when

- `systemctl --user is-active keto.service` is `active`, or you report the exact systemd error.
- `curl -sf http://127.0.0.1:8787/` returns HTML containing `20`.
- `python3 check.py` exits 0.
- README states the URL, the MCP command, and that the Google Sheet was not migrated.
