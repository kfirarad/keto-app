# Keto tracker

A private daily keto log for this Raspberry Pi. Python 3.11 stdlib only.

- URL: http://127.0.0.1:8787/ (loopback only, no auth)
- Database: `/home/kfir/dev/keto/data/keto.sqlite` (SQLite, WAL)
- "Today" is Europe/Copenhagen. Dates in the UI and MCP are `DD/MM/YYYY`.
- Net-carb goal: 20 g by default, adjustable per day (see below).

Food rows from the Google Sheet `יומן תזונה` were copied in once (`source = sheet`). Subtotal and daily-total rows were not copied; the app sums the food rows. The sheet itself was not modified.

## Web process

```
python3 server.py
```

Runs as a systemd user unit:

```
cp keto.service ~/.config/systemd/user/keto.service
systemctl --user daemon-reload && systemctl --user enable --now keto.service
```

### Using the UI

- **Log again**: the most-logged items of the last 30 days sit above the form. One tap adds the item now (meal taken from an entry logged up to 2 h earlier that day), with Undo in the notice at the bottom.
- **Copy**: "Copy entries to another day" (or Copy on a meal header) opens a checklist; pick the entries and the target date, optionally keeping times. Undo is available.
- **Add form**: item, quantity, weight and the four numbers are always visible; date, time, meal (with suggestions from past meals), fasting hours, notes and a label calculator (total carbs − fiber − sugar alcohols = net carbs) are under More. Before saving, a line shows the day's net carbs after this entry. Portion buttons (×½ to ×2) scale a loaded entry. A floating "Add food" button jumps to the form.
- **Overview**: macros with their share of energy, the eating window (first to last food), and a 7-day strip of net carbs against each day's goal (tap a day to open it), with the average, days within goal and the streak of consecutive days within goal.
- **Fasting target**: pick a target (default 16 h, remembered in this browser); the running fast shows a progress bar and the time left.
- **Body**: weight (kg), ketones and glucose (mmol/L) and water per day. Shows change since the previous weigh-in, a 30-day weight line, and GKI (glucose ÷ ketones) with its band.
- **Export**: CSV links at the bottom for entries, fasts and body readings.
- **Entries**: every row has Edit and Delete. Edit loads the row into the form (Save / Cancel); changing its date moves it to that day.
- **Past items**: typing in Item suggests earlier items (latest values per item). Picking one fills quantity and macros and shows a Weight field. Changing the weight scales the quantity's numbers and all four macros proportionally. The base weight is the grams in each `+`-separated part of the quantity, e.g. `3 ביצים (124 גרם) + 18 גרם חמאה` is 142 g; with no grams in the quantity the field is a portion multiplier.
- **Fasting**: Start fasting / Stop fasting, with a native date-time field that defaults to now and can be moved to when the fast really started or ended. The running fast shows its elapsed time. Fasts are listed on the day they ended and can be edited or deleted. Stopping a fast prefills its hours into the add form's Fasting hours, so the entry that breaks the fast carries them.
- **Daily goal**: Change under the hero sets the net-carb goal for the day shown. A day with no goal of its own carries over the goal of the nearest earlier day that has one. Changing a goal flows forward to later days that have no entries yet; days that already have entries keep the goal they had.

### HTTP API

- `GET /` — the UI
- `GET /api/day?date=DD/MM/YYYY` — entries, totals, `goal`, `goal_source` (`set`/`inherited`/`default`), `remaining`, `over_goal`, `fasts` (ended that day), `fast_hours`, `active_fast` (missing date = today)
- `POST /api/entries` — one object or a list. Fields: `date`, `time`, `fasting_hours`, `item`, `quantity`, `calories`, `fat_g`, `protein_g`, `net_carbs_g`, `notes`, `meal`. `item` and `net_carbs_g` are required.
- `PATCH /api/entries/<id>` — change some fields (null clears an optional field); `DELETE /api/entries/<id>`
- `GET /api/recent?n=14` — one summary per day, newest first
- `GET /api/foods` — latest row per distinct item, most recent first (used for suggestions); `?top=8` gives the most-logged items of the last 30 days
- `GET /api/meals` — past meal names, most used first
- `GET /api/days?end=DD/MM/YYYY&n=7` — calendar-day summaries oldest first (empty days included), average, days within goal, `streak {current, best}`
- `POST /api/body` — `{date, weight_kg, ketones_mmol, glucose_mmol, water_ml}` (omitted = unchanged, null clears) or `add_water_ml`; the day payload has `body` with `gki`, `gki_band`, `weight_change_kg`, `weights`
- `GET /api/export.csv?table=entries|fasts|body` — CSV download (DD/MM/YYYY dates, UTF-8 with BOM)
- `POST /api/fasts/start`, `POST /api/fasts/stop` — body `{date, time, notes}`, all optional (default now). One fast can run at a time (409 otherwise).
- `PATCH /api/fasts/<id>` — `start_date`, `start_time`, `end_date`, `end_time`, `notes`; `DELETE /api/fasts/<id>`
- `POST /api/goal` — `{date, net_carbs_goal}`; `null` resets the day to its carried-over goal

## MCP server (stdio)

Exact command:

```
/usr/bin/python3 /home/kfir/dev/keto/mcp_server.py
```

Tools: `add_entries` (`entries`: array), `get_day` (`date`, optional), `recent_days` (`n`, optional, default 14, max 60), `update_entry` (`id` + fields), `delete_entry` (`id`), `start_fast` / `stop_fast` (`date`, `time`, `notes`, optional), `update_fast` (`id` + fields), `delete_fast` (`id`), `set_goal` (`date`, `net_carbs_goal`), `log_body` (`date`, `weight_kg`, `ketones_mmol`, `glucose_mmol`, `water_ml` or `add_water_ml`). Rows and fasts added through MCP get `source = "mcp"`.

Claude Code:

```
claude mcp add keto -- /usr/bin/python3 /home/kfir/dev/keto/mcp_server.py
```

Generic MCP config:

```json
{
  "mcpServers": {
    "keto": {
      "command": "/usr/bin/python3",
      "args": ["/home/kfir/dev/keto/mcp_server.py"]
    }
  }
}
```

The server is not registered with Hermes or Claude; add it yourself with one of the above.

## Check

```
python3 check.py
```

Uses a temporary database via `KETO_DB`; never touches `data/keto.sqlite`. Works with the service running or stopped.
