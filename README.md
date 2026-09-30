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

The layout follows `design/redesign.html` (PR #1), top to bottom:

- **Day navigation** (sticky): previous / next day, the date and weekday, Today.
- **At a glance**: net carbs against the day's goal with what is left or over (green under, orange over), the goal line with Change, macros with their share of energy, the eating window (first to last food) and fasting hours, and the fast: running time, Stop fast, progress toward the target and when it ends ("ends in 1:09 · 14:30"), and Adjust start to move the start back when Start was pressed late (a date-time field with −15 m / −30 m / −1 h; Start fast also offers Adjust and Undo in its notice); or "Not fasting" with the last fast or last food and Start fast. On other days the panel shows that day's fasting instead: each fast that overlaps the day (started, ended, or spanning it; for days logged before the fast tracker, the fasting hours on the entry that broke a fast), a 24-hour bar with fasting in blue and food times marked, and how much of the day was fasted.
- **Log again**: chips for the most-logged items of the last 30 days. One tap adds the item to the day shown at the current time (meal taken from an entry logged up to 2 h earlier that day), with Undo.
- **Log**: entries in time order, grouped into runs by meal with a carb subtotal and Copy per meal. Each row is one line (time, item and quantity, net carbs); tap it for notes, macros, "added by agent" for MCP rows, and Edit / Log again now / Delete. Delete has Undo (the row comes back with its id and source). "Copy entries to another day" opens a checklist sheet with a target day and "keep times"; Undo removes the copies.
- **Week / Fasting / Body** (collapsed): the 7-day strip of net carbs against each day's goal (tap a day to open it) with average, days within goal and streak; fasting with a date-time field for when the fast really started or stopped, the target (default 16 h, remembered in this browser), and the running and ended fasts with Edit / Delete; body: the day's measurements with Edit / Delete and Add measurement, the latest value of each (a later time wins; untimed readings count as the start of the day), GKI (latest glucose ÷ latest ketones) with its band, change since the previous day's weight, a 30-day weight line (each day's last weight), and water (+250 / +500 / −250).
- **Measure** (pinned bar, next to Add food): a sheet with date, time (default now), blood pressure (systolic / diastolic, mmHg), weight (kg), blood ketones (mmol/L), glucose (mmol/L or mg/dL: a switch next to the field, remembered in this browser and used everywhere glucose is shown; stored as mmol/L, 1 mmol/L = 18.016 mg/dL), pulse (bpm) and notes. Any subset; blood pressure needs both numbers. Several measurements per day are fine.
- **Import from sheet** (footer): paste rows copied from the old Google Sheet (tab-separated, or tabs turned into four spaces), columns: date, time (HH:MM or HH:MM:SS), fasting hours, item, quantity, calories, fat, protein, net carbs, notes. A live preview lists what will be added. Rows whose item starts with `סה"כ` are meal totals: skipped, and the rest of their name becomes the meal of the rows with the same date and time. Rows already in the log (same date, time, item, quantity) are skipped; a row that fails validation blocks the import. Imported rows get `source = "sheet"`; the notice offers Undo.
- **Add food** (pinned bar with what is left): opens a sheet. Typing an item suggests past items; picking one fills quantity and macros and shows Weight with ×½ ×1 ×1½ ×2. Changing the weight scales the quantity's numbers and all four macros; the base weight is the grams in each `+`-separated part of the quantity, e.g. `3 ביצים (124 גרם) + 18 גרם חמאה` is 142 g, and with no grams it is a portion multiplier. "After this" shows the day's net carbs with this entry. More holds date, time, meal (suggests past meals), fasting hours, notes, and a label calculator (total carbs − fiber − sugar alcohols). The sheet stays open after Add for the next item; date, time and meal are kept. Edit uses the same sheet. Stopping a fast offers "Log meal" with the fast's hours prefilled.
- **Changing days**: days run from the first tracked day (the earliest entry, fast, measurement or water) to today; ‹ is disabled on the first day, › on today, and week-strip days before the first day are disabled. Copying or moving entries to a future day stays on today. The old day dims while the next loads, then the new day slides in from the side it came from (off with reduced motion).
- **Export**: CSV links at the bottom for entries, fasts, measurements and water.
- **Daily goal**: a day with no goal of its own carries over the goal of the nearest earlier day that has one. Changing a goal flows forward to later days that have no entries yet; days that already have entries keep the goal they had.

Light and dark follow the system setting.

### HTTP API

- `GET /` — the UI
- `GET /api/day?date=DD/MM/YYYY` — entries, totals, `goal`, `goal_source` (`set`/`inherited`/`default`), `remaining`, `over_goal`, `fasts` (ended that day), `fast_hours`, `day_fasts` (every fast overlapping that day), `active_fast`, `first_date` (the first tracked day, never after today) (missing date = today)
- `POST /api/entries` — one object or a list. Fields: `date`, `time`, `fasting_hours`, `item`, `quantity`, `calories`, `fat_g`, `protein_g`, `net_carbs_g`, `notes`, `meal`. `item` and `net_carbs_g` are required.
- `PATCH /api/entries/<id>` — change some fields (null clears an optional field); `DELETE /api/entries/<id>` returns the deleted row
- `POST /api/entries/restore` — put back a deleted row as DELETE returned it (same id if free, same source and created_at); used by Undo
- `GET /api/recent?n=14` — one summary per day, newest first
- `GET /api/foods` — latest row per distinct item, most recent first (used for suggestions); `?top=8` gives the most-logged items of the last 30 days
- `GET /api/meals` — past meal names, most used first
- `GET /api/days?end=DD/MM/YYYY&n=7` — calendar-day summaries oldest first (empty days included), average, days within goal, `streak {current, best}`
- `POST /api/measurements` — `{date, time, weight_kg, ketones_mmol, glucose_mmol, bp_sys, bp_dia, pulse, notes}`, at least one value; `PATCH` / `DELETE /api/measurements/<id>`. The day payload has `body` with the latest of each value, `gki`, `gki_band`, `weight_change_kg`, `weights`, `water_ml` and `measurements`.
- `POST /api/body` — water: `{date, water_ml}` or `{date, add_water_ml}`; `weight_kg`, `ketones_mmol`, `glucose_mmol` here are saved as a new measurement (kept for older callers)
- `POST /api/import` — `{text, dry_run}`: sheet rows as above; returns `rows` (with `duplicate`), `totals`, `errors`, `new`, `duplicates`, `created`

Old daily readings (weight, ketones, glucose in `body_log`) are moved into `measurements` without a time the first time the new code opens the database; `body_log` keeps only water.
- `GET /api/export.csv?table=entries|fasts|measurements|body` (`body` = water) — CSV download (DD/MM/YYYY dates, UTF-8 with BOM)
- `POST /api/fasts/start`, `POST /api/fasts/stop` — body `{date, time, notes}`, all optional (default now). One fast can run at a time (409 otherwise).
- `PATCH /api/fasts/<id>` — `start_date`, `start_time`, `end_date`, `end_time`, `notes`; `DELETE /api/fasts/<id>`
- `POST /api/goal` — `{date, net_carbs_goal}`; `null` resets the day to its carried-over goal

## MCP server (stdio)

Exact command:

```
/usr/bin/python3 /home/kfir/dev/keto/mcp_server.py
```

Tools: `add_entries` (`entries`: array), `get_day` (`date`, optional), `recent_days` (`n`, optional, default 14, max 60), `update_entry` (`id` + fields), `delete_entry` (`id`), `start_fast` / `stop_fast` (`date`, `time`, `notes`, optional), `update_fast` (`id` + fields), `delete_fast` (`id`), `set_goal` (`date`, `net_carbs_goal`), `add_measurement` (`date`, `time`, `weight_kg`, `ketones_mmol`, `glucose_mmol`, `bp_sys`, `bp_dia`, `pulse`, `notes`), `update_measurement` (`id` + fields), `delete_measurement` (`id`), `log_body` (`date`, `water_ml` or `add_water_ml`; weight/ketones/glucose become a measurement). Rows, fasts and measurements added through MCP get `source = "mcp"`.

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
