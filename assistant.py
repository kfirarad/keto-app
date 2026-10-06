"""What the keto log asks the model: food rows from words or a photo, a coach
chat that sees the log, and a written review. The model never writes to the
database; rows come back for the user to review and are saved through the
normal entries API."""

import hashlib
import json
import re
from datetime import datetime

import db
import llm

MAX_TEXT = 2000
MAX_IMAGE_CHARS = 3_500_000
MAX_TURNS = 12
MAX_TURN_CHARS = 4000
MAX_ROWS = 30
KNOWN_FOODS = 120
BASES = ("history", "label", "estimate")
MACROS = ("net_carbs_g", "calories", "fat_g", "protein_g")
_IMAGE_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$")
_LOG_RE = re.compile(r"\n?\s*LOG:\s*", re.I)

ROW_FORMAT = (
    '{"item": "name", "quantity": "amount, with grams when known", "net_carbs_g": 0,'
    ' "calories": 0, "fat_g": 0, "protein_g": 0, "basis": "history" | "label" | "estimate"}'
)
ROW_RULES = f"""Row format: {ROW_FORMAT}
Rules for rows:
- One row per food. Numbers are for the amount eaten, plain numbers without units.
- net_carbs_g is total carbohydrate minus fibre minus sugar alcohols.
- Write item and quantity in the language the user used. Quantity is short, e.g. "2 ביצים (100 גרם)" or "150 g".
- If the food is in KNOWN FOODS, use that exact item name, scale its numbers to the amount eaten, and set basis "history".
- Numbers read from a nutrition label in a photo: basis "label". Scale per-100 g values to the amount eaten; if the amount is unknown use one serving and say so in quantity.
- Otherwise use standard nutrition data and set basis "estimate"."""

FOOD_SYSTEM = f"""You turn a description or photo of food into rows for a keto food log.
Reply with one JSON object and nothing else:
{{"rows": [row, ...], "question": null}}
{ROW_RULES}
- If nothing can be logged, return no rows and put a short question in "question" saying what is missing. An unknown amount is not a reason to ask: assume a usual portion."""

COACH_SYSTEM = f"""You are a keto coach inside the user's personal food log. You see their data in LOG DATA.
- Be concrete and brief: a few short sentences or a short list. Use their numbers, goal and foods.
- Answer in the language of the user's last message. Plain text only, no markdown, no tables.
- Dates are DD/MM/YYYY. Net carbs are what counts against the daily goal.
- You cannot change the log. When the user asks you to log food, or accepts food you suggested, finish your reply with a line that starts with LOG: followed by one JSON object {{"rows": [row, ...]}}; the app shows those rows for the user to review and save. Do not add LOG: otherwise.
{ROW_RULES}
- You are not a doctor. For worrying blood pressure, glucose or symptoms, say so briefly and point to a doctor."""

SUMMARY_SYSTEM = """You review a period of the user's keto food log from the numbers in LOG DATA.
Write at most 120 words of plain text, no markdown, no headings: what went well, what to watch,
and one concrete suggestion for the coming days. Use the actual numbers and food names, do not
list every statistic, and do not give medical advice. Averages leave out today, which is still in progress."""


def _known_foods():
    lines = []
    for f in db.recent_foods()[:KNOWN_FOODS]:
        lines.append(" | ".join(str(x) for x in (
            f["item"], f.get("quantity") or "-", f["net_carbs_g"], f.get("calories"),
            f.get("fat_g"), f.get("protein_g"))))
    return "KNOWN FOODS (item | quantity | net carbs g | kcal | fat g | protein g):\n" + ("\n".join(lines) or "(none yet)")


def _clean_rows(rows, known=None):
    """Keep rows that would be accepted as entries; returns (rows, dropped)."""
    if known is None:
        known = {f["item"] for f in db.recent_foods()}
    out, dropped = [], 0
    for r in rows if isinstance(rows, list) else []:
        if len(out) >= MAX_ROWS:
            break
        try:
            row = {"item": r["item"].strip(), "quantity": (str(r["quantity"]).strip() or None)
                   if r.get("quantity") is not None else None}
            for f in MACROS:
                v = r.get(f)
                if isinstance(v, str):
                    v = float(v.replace(",", ".").strip())
                row[f] = None if v is None else round(float(v), 1)
            checked = db.validate_entry(row)
            if any(checked[f] is not None and not 0 <= checked[f] <= 20000 for f in MACROS):
                raise db.ValidationError("out of range")
        except (db.ValidationError, KeyError, TypeError, ValueError, AttributeError):
            dropped += 1
            continue
        basis = r.get("basis") if r.get("basis") in BASES else "estimate"
        if basis == "history" and row["item"] not in known:
            basis = "estimate"
        row["basis"] = basis
        out.append(row)
    return out, dropped


def parse_food(payload):
    """Words and/or a photo -> rows to review. Writes nothing."""
    if not isinstance(payload, dict):
        raise db.ValidationError("body must be {text, image}")
    text = payload.get("text") or ""
    image = payload.get("image")
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise db.ValidationError(f"text must be at most {MAX_TEXT} characters")
    if image is not None and (not isinstance(image, str) or len(image) > MAX_IMAGE_CHARS
                              or not _IMAGE_RE.match(image)):
        raise db.ValidationError("image must be a JPEG, PNG or WebP data URL of at most 2.5 MB")
    if not text.strip() and not image:
        raise db.ValidationError("describe the food or add a photo")
    ask = text.strip() or "Log the food in this photo."
    user = [{"type": "text", "text": ask}, {"type": "image_url", "image_url": {"url": image}}] if image else ask
    reply = llm.chat([
        {"role": "system", "content": FOOD_SYSTEM + "\n\n" + _known_foods()},
        {"role": "user", "content": user},
    ], vision=bool(image))
    obj = llm.extract_json(reply)
    if obj is None:
        raise llm.LLMError("the model did not answer with rows, try again or rephrase")
    rows, dropped = _clean_rows(obj.get("rows"))
    question = obj.get("question")
    return {"rows": rows, "dropped": dropped,
            "question": question.strip() if isinstance(question, str) and question.strip() else None}


def _log_data(days):
    """A compact snapshot of the log for the coach."""
    now = datetime.now(db.TZ)
    day = db.get_day()
    ins = db.insights(days)
    fast = day["active_fast"]
    return {
        "now": now.strftime("%d/%m/%Y %H:%M, %A"),
        "today": {
            "net_carbs_goal_g": day["goal"], "remaining_g": day["remaining"], "totals": day["totals"],
            "entries": [{k: e[k] for k in ("time", "item", "quantity", "meal") + MACROS if e.get(k) is not None}
                        for e in day["entries"]],
            "fasting_now_hours": fast["hours_so_far"] if fast else None,
            "measurements": [{k: v for k, v in m.items() if v is not None and k in ("time",) + tuple(db.MEASURE_FIELDS)}
                             for m in day["body"]["measurements"]],
            "water_ml": day["body"]["water_ml"],
        },
        "period": {"from": ins["from"], "to": ins["to"], "summary": ins["summary"],
                   "days": [{k: v for k, v in d.items() if v is not None and k != "count"}
                            for d in ins["days"] if d["count"] or d["fast_hours"] or d["weight_kg"] is not None],
                   "top_carb_foods": ins["foods"]},
    }


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def chat(payload):
    """Coach reply for a thread held by the browser. {reply, rows}."""
    msgs = payload.get("messages") if isinstance(payload, dict) else None
    if not isinstance(msgs, list) or not msgs:
        raise db.ValidationError("messages must be a non-empty list")
    turns = []
    for m in msgs[-MAX_TURNS:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") \
                or not isinstance(m.get("content"), str) or not m["content"].strip():
            raise db.ValidationError("each message needs role user or assistant and text content")
        turns.append({"role": m["role"], "content": m["content"][:MAX_TURN_CHARS]})
    if turns[-1]["role"] != "user":
        raise db.ValidationError("the last message must be from the user")
    while turns[0]["role"] != "user":
        turns.pop(0)
    system = "\n\n".join([COACH_SYSTEM, _known_foods(), "LOG DATA:\n" + _dump(_log_data(14))])
    reply = llm.chat([{"role": "system", "content": system}] + turns, temperature=0.4)
    rows = []
    parts = _LOG_RE.split(reply)
    if len(parts) > 1:
        obj = llm.extract_json(parts[-1])
        if obj is not None:
            rows, _ = _clean_rows(obj.get("rows"))
            reply = "LOG:".join(parts[:-1]).strip()
    reply = reply.replace("**", "").strip()
    return {"reply": reply or "Here are the rows to review.", "rows": rows}


_summaries = {}     # (days, data hash) -> result; the same numbers give the same review


def summary(payload):
    """A short written review of the range shown on the Insights tab."""
    payload = payload if isinstance(payload, dict) else {}
    ins = db.insights(payload.get("days"))
    if not ins["summary"]["logged_days"]:
        raise db.ValidationError("there is no full logged day in this range yet")
    data = _dump({"from": ins["from"], "to": ins["to"], "summary": ins["summary"],
                  "days": [{k: v for k, v in d.items() if v is not None} for d in ins["days"]],
                  "top_carb_foods": ins["foods"]})
    key = (str(payload.get("days")), hashlib.sha256(data.encode("utf-8")).hexdigest())
    if key in _summaries and not payload.get("refresh"):
        return _summaries[key]
    text = llm.chat([{"role": "system", "content": SUMMARY_SYSTEM},
                     {"role": "user", "content": "LOG DATA:\n" + data}], max_tokens=600, temperature=0.4)
    out = {"text": text.replace("**", "").strip(), "from": ins["from"], "to": ins["to"],
           "generated_at": datetime.now(db.TZ).strftime("%d/%m/%Y %H:%M"), "model": llm.status()["model"]}
    _summaries.clear()
    _summaries[key] = out
    return out
