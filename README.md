# Keto tracker

A private daily keto log for this Raspberry Pi. Python 3.11 stdlib only.

- URL: http://127.0.0.1:8787/ (loopback only, no auth)
- Database: `/home/kfir/dev/keto/data/keto.sqlite` (SQLite, WAL)
- "Today" is Europe/Copenhagen. Dates in the UI and MCP are `DD/MM/YYYY`.
- Net-carb goal: 20 g.

This is a new log. The Google Sheet was not migrated, read, or modified.

## Web process

```
python3 server.py
```

Runs as a systemd user unit:

```
cp keto.service ~/.config/systemd/user/keto.service
systemctl --user daemon-reload && systemctl --user enable --now keto.service
```

### HTTP API

- `GET /` — the UI
- `GET /api/day?date=DD/MM/YYYY` — entries, totals, `goal`, `remaining`, `over_goal` (missing date = today)
- `POST /api/entries` — one object or a list. Fields: `date`, `time`, `fasting_hours`, `item`, `quantity`, `calories`, `fat_g`, `protein_g`, `net_carbs_g`, `notes`, `meal`. `item` and `net_carbs_g` are required.
- `GET /api/recent?n=14` — one summary per day, newest first

## MCP server (stdio)

Exact command:

```
/usr/bin/python3 /home/kfir/dev/keto/mcp_server.py
```

Tools: `add_entries` (`entries`: array), `get_day` (`date`, optional), `recent_days` (`n`, optional, default 14, max 60). Rows added through MCP get `source = "mcp"`.

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
