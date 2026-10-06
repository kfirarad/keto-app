"""Client for an OpenAI-compatible chat API (OpenCode Zen / Go). Stdlib only.

Settings come from data/llm.json (see llm.example.json); KETO_LLM_API_KEY,
KETO_LLM_BASE_URL, KETO_LLM_MODEL and KETO_LLM_VISION_MODEL override it, and
KETO_LLM_CONFIG names another file. The file is read on every call, so a
change needs no restart. The key never leaves this module.
"""

import json
import os
import re
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "llm.json")
DEFAULTS = {
    "api_key": "",
    "base_url": "https://opencode.ai/zen/v1",
    "model": "space-bunny-free",
    "vision_model": "",          # a model that accepts images; empty turns photos off
    "reasoning_effort": "low",   # for thinking models; dropped if the model refuses it
    "timeout_s": 90,
}
MAX_REPLY = 200_000
_PROCESS_SESSION = uuid.uuid4().hex     # for one-off requests
_THINK_RE = re.compile(r"<think>.*?</think>", re.S)
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


class LLMError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def config():
    cfg = dict(DEFAULTS)
    try:
        with open(os.environ.get("KETO_LLM_CONFIG") or CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update({k: v for k, v in data.items() if k in DEFAULTS and v is not None})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        raise LLMError(f"cannot read the LLM settings file: {e}", 503)
    for key, env in (("api_key", "KETO_LLM_API_KEY"), ("base_url", "KETO_LLM_BASE_URL"),
                     ("model", "KETO_LLM_MODEL"), ("vision_model", "KETO_LLM_VISION_MODEL")):
        if os.environ.get(env) is not None:
            cfg[key] = os.environ[env]
    for key in ("api_key", "base_url", "model", "vision_model"):
        cfg[key] = str(cfg[key]).strip()
    cfg["base_url"] = cfg["base_url"].rstrip("/")
    return cfg


def enabled():
    try:
        cfg = config()
    except LLMError:
        return False
    return bool(cfg["api_key"] and cfg["base_url"] and cfg["model"])


def status():
    """What the UI may know: never the key."""
    try:
        cfg = config()
    except LLMError as e:
        return {"enabled": False, "model": None, "vision": False, "error": str(e)}
    on = bool(cfg["api_key"] and cfg["base_url"] and cfg["model"])
    return {"enabled": on, "model": cfg["model"] if on else None,
            "vision": bool(on and cfg["vision_model"])}


def _check_url(base_url):
    u = urlparse(base_url)
    local = u.hostname in ("127.0.0.1", "localhost", "::1")
    if u.scheme != "https" and not (u.scheme == "http" and local):
        raise LLMError("LLM base_url must be https", 503)


def chat(messages, vision=False, max_tokens=6000, temperature=0.2, session=None):
    """Send a chat and return the reply text. `session` is a stable id for one
    conversation; OpenCode routes and caches by it (x-opencode-session)."""
    cfg = config()
    if not (cfg["api_key"] and cfg["base_url"] and cfg["model"]):
        raise LLMError("the assistant is not set up (data/llm.json)", 503)
    model = cfg["model"]
    if vision:
        if not cfg["vision_model"]:
            raise LLMError("no vision model is set up for photos", 503)
        model = cfg["vision_model"]
    _check_url(cfg["base_url"])
    body = {"model": model, "messages": messages, "max_tokens": max_tokens,
            "temperature": temperature, "stream": False}
    effort = str(cfg["reasoning_effort"] or "").strip()
    if effort:
        body["reasoning_effort"] = effort
    try:
        timeout = float(cfg["timeout_s"])
    except (TypeError, ValueError):
        timeout = DEFAULTS["timeout_s"]

    def post():
        req = urllib.request.Request(
            cfg["base_url"] + "/chat/completions", data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + cfg["api_key"],
                     "User-Agent": "keto-log/1",
                     "x-opencode-session": session or _PROCESS_SESSION})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(MAX_REPLY + 1)

    def detail_of(e):
        try:
            err = json.loads(e.read(4000).decode("utf-8", "replace"))
            return err.get("error", {}).get("message") if isinstance(err.get("error"), dict) else err.get("error")
        except (ValueError, AttributeError):
            return ""

    try:
        try:
            raw = post()
        except urllib.error.HTTPError as e:
            detail = detail_of(e)
            # A model that does not take reasoning_effort: ask again without it.
            if e.code != 400 or "reasoning_effort" not in body or "reasoning" not in str(detail):
                e.keto_detail = detail
                raise
            del body["reasoning_effort"]
            raw = post()
    except urllib.error.HTTPError as e:
        detail = getattr(e, "keto_detail", None)
        if detail is None:
            detail = detail_of(e)
        what = {401: "the API key was rejected", 403: "the API key may not use this model",
                404: f"model {model!r} was not found", 429: "the model is rate limited, try again shortly"}
        raise LLMError(f"the model service answered {e.code}: {what.get(e.code) or detail or 'error'}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise LLMError(f"could not reach the model service: {getattr(e, 'reason', e)}")
    try:
        msg = json.loads(raw.decode("utf-8"))["choices"][0]["message"]
        content = msg.get("content")
        if isinstance(content, list):      # some models answer in parts
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    except (ValueError, LookupError, TypeError, AttributeError):
        raise LLMError("the model service sent an answer that could not be read")
    text = _THINK_RE.sub("", content or "").strip()
    if not text:
        raise LLMError("the model sent an empty answer, try again")
    return text


def extract_json(text):
    """The first JSON object in a reply, tolerating code fences and prose
    around it. None when there is none."""
    if not isinstance(text, str):
        return None
    candidates = [m.group(1) for m in _FENCE_RE.finditer(text)] + [text]
    dec = json.JSONDecoder()
    for c in candidates:
        i = c.find("{")
        while i != -1:
            try:
                obj, _ = dec.raw_decode(c[i:])
                if isinstance(obj, dict):
                    return obj
            except ValueError:
                pass
            i = c.find("{", i + 1)
    return None
