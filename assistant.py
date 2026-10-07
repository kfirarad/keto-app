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
- Keep the whole reply under 150 words.
- You cannot change the log, so never say that you added or logged something. When the user asks you to log food, a workout, a symptom, a note or a body measurement (weight, blood glucose, blood ketones, blood pressure, pulse), or accepts something you suggested, say it is ready to approve and finish your reply with a line that starts with LOG: followed by one JSON object {{"rows": [row, ...], "notes": [note, ...], "measurements": [measurement, ...]}} (leave out the lists you do not need); the app shows it for the user to approve. Do not add LOG: otherwise.
- Note format: {{"date": "DD/MM/YYYY", "time": "HH:MM", "workout": "Run", "minutes": 32, "symptoms": ["Headache"], "notes": "free text"}}. Every field is optional but a note needs a workout, a symptom or text. A workout is one short kind (Run, Walk, Gym, Bike, Swim, Yoga, ...) with minutes when known; put distance, pace and other details in notes. Symptoms are short names. Leave out date and time for now; use them when the user says when it happened.
- Measurement format: {{"date": "DD/MM/YYYY", "time": "HH:MM", "weight_kg": 82.4, "glucose_mmol": 5.1, "ketones_mmol": 1.8, "bp_sys": 121, "bp_dia": 79, "pulse": 62, "notes": "free text"}}. Give only the values the user stated, never guess one. Values taken at the same moment go in one measurement. Glucose and ketones are blood values in mmol/L: convert glucose given in mg/dL by dividing by 18. Blood pressure needs both numbers. Date and time as for notes.
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


def _clean_notes(notes):
    """Keep proposed notes / workouts that would be accepted; dates and times filled in."""
    out = []
    for n in notes if isinstance(notes, list) else []:
        if len(out) >= 10:
            break
        try:
            r = db.validate_note({k: n[k] for k in db.NOTE_INPUT if n.get(k) not in (None, "", [])})
        except (db.ValidationError, TypeError, AttributeError):
            continue
        if r["n_date"] > db.today_iso():
            continue
        out.append({"date": db.format_date(r["n_date"]),
                    "time": r["n_time"] or (db.now_hhmm() if r["n_date"] == db.today_iso() else None),
                    "workout": r["workout"], "minutes": None if r["minutes"] is None else db._clean_num(r["minutes"]),
                    "symptoms": json.loads(r["symptoms"]), "notes": r["notes"]})
    return out


def _clean_measurements(items):
    """Keep proposed body measurements that would be accepted."""
    out = []
    for m in items if isinstance(items, list) else []:
        if len(out) >= 10:
            break
        try:
            obj = {k: m[k] for k in db.MEASURE_INPUT if m.get(k) not in (None, "")}
            g = obj.get("glucose_mmol")
            # Nobody has 40+ mmol/L: a number that high was given in mg/dL.
            if isinstance(g, (int, float)) and not isinstance(g, bool) and 40 < g <= 720:
                obj["glucose_mmol"] = round(g / 18.016, 2)
            r = db.validate_measurement(obj)
        except (db.ValidationError, TypeError, AttributeError):
            continue
        if r["m_date"] > db.today_iso():
            continue
        out.append({"date": db.format_date(r["m_date"]),
                    "time": r["m_time"] or (db.now_hhmm() if r["m_date"] == db.today_iso() else None),
                    **{f: None if r[f] is None else db._clean_num(r[f]) for f in db.MEASURE_FIELDS},
                    "notes": r["notes"]})
    return out


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
            "workouts_symptoms_notes": [{k: n[k] for k in ("time", "workout", "minutes", "symptoms", "notes") if n[k]}
                                        for n in day["notes"]],
        },
        "period": {"from": ins["from"], "to": ins["to"], "summary": ins["summary"],
                   "days": [{k: v for k, v in d.items() if v is not None and k != "count"}
                            for d in ins["days"] if d["count"] or d["fast_hours"] or d["weight_kg"] is not None],
                   "top_carb_foods": ins["foods"]},
    }


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def chat(payload):
    """One coach turn in a chat stored in the database, so every device sees it.

    {chat_id, message}: add the user's message (chat_id null starts a chat) and
    answer it. {chat_id, retry: true}: answer the last message again after a
    failure. Returns {chat}; on a model failure the user's message stays saved
    and the error carries the chat.
    """
    if not isinstance(payload, dict):
        raise db.ValidationError("body must be {chat_id, message}")
    db._check_fields(payload, ("chat_id", "message", "retry"), "chat request")
    cid = payload.get("chat_id")
    if not llm.enabled():      # before saving anything
        raise llm.LLMError("the assistant is not set up (data/llm.json)", 503)
    if payload.get("retry"):
        saved = db.get_chat(cid)
        if not saved["messages"] or saved["messages"][-1]["role"] != "user":
            raise db.ValidationError("nothing to retry in this chat")
    else:
        saved = db.add_chat_message(cid, "user", payload.get("message"))
    turns = [{"role": m["role"], "content": m["content"][:MAX_TURN_CHARS]} for m in saved["messages"][-MAX_TURNS:]]
    while turns[0]["role"] != "user":
        turns.pop(0)
    system = "\n\n".join([COACH_SYSTEM, _known_foods(), "LOG DATA:\n" + _dump(_log_data(14))])
    session = hashlib.sha256(f"keto-chat-{saved['id']}-{saved['created_at']}".encode("utf-8")).hexdigest()[:32]
    try:
        reply = llm.chat([{"role": "system", "content": system}] + turns, temperature=0.4, session=session)
    except llm.LLMError as e:
        e.data = {"chat": saved}
        raise
    rows, notes, measures = [], [], []
    parts = _LOG_RE.split(reply)
    if len(parts) > 1:
        obj = llm.extract_json(parts[-1])
        if obj is not None:
            rows, _ = _clean_rows(obj.get("rows"))
            notes = _clean_notes(obj.get("notes"))
            measures = _clean_measurements(obj.get("measurements"))
            reply = "LOG:".join(parts[:-1]).strip()
    reply = reply.replace("**", "").strip()
    return {"chat": db.add_chat_message(saved["id"], "assistant", reply or "Ready for you to approve.", rows, notes, measures)}


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
                     {"role": "user", "content": "LOG DATA:\n" + data}], temperature=0.4)
    out = {"text": text.replace("**", "").strip(), "from": ins["from"], "to": ins["to"],
           "generated_at": datetime.now(db.TZ).strftime("%d/%m/%Y %H:%M"), "model": llm.status()["model"]}
    _summaries.clear()
    _summaries[key] = out
    return out
