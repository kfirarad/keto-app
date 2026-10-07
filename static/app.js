/* Keto log UI. Layout and components follow design/redesign.html (PR #1);
   data comes from the JSON API in server.py. */
(function () {
"use strict";

const TZ = "Europe/Copenhagen";
const TICK_MS = 30000;
const MACROS = ["net_carbs_g", "calories", "fat_g", "protein_g"];

/* ---------- time and formatting ---------- */
const now = () => new Date();
function parts(d) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) p[x.type] = x.value;
  return p;
}
const dmy = d => { const p = parts(d); return `${p.day}/${p.month}/${p.year}`; };
const hm = d => { const p = parts(d); return `${p.hour}:${p.minute}`; };
const isoLocal = d => { const p = parts(d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const dmyToIso = s => s.split("/").reverse().join("-");
const isoToDmy = s => s.split("-").reverse().join("/");
const dmyToDate = s => new Date(dmyToIso(s) + "T12:00:00Z");
const addDays = (s, n) => { const d = dmyToDate(s); d.setUTCDate(d.getUTCDate() + n); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };
const weekday = (s, len) => dmyToDate(s).toLocaleDateString("en-GB", { weekday: len, timeZone: "UTC" });
const today = () => dmy(now());
const after = (a, b) => dmyToIso(a) > dmyToIso(b);                 // DD/MM/YYYY a is later than b
const g = n => String(Math.round((+n || 0) * 10) / 10);            // 17.3, 1, 0
const kcal = n => String(Math.round(+n || 0));
const tidy = x => String(Math.round(x * 100) / 100);
const num = s => parseFloat(String(s).replace(",", "."));
const dur = h => { const m = Math.max(0, Math.round(h * 60)); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`; };
const hmm = h => { const m = Math.max(0, Math.round(h * 60)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
// Clock time of an instant, with the date when it is not today.
const clockAt = ms => { const d = new Date(ms); return dmy(d) === today() ? hm(d) : `${dmy(d).slice(0, 5)} ${hm(d)}`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ut = s => `<bdi dir="auto">${esc(s)}</bdi>`;                 // user text, direction isolated
const toLocal = (d, t) => d && t ? `${dmyToIso(d)}T${t}` : "";      // API date+time -> datetime-local
const fromLocal = v => v ? { date: isoToDmy(v.slice(0, 10)), time: v.slice(11, 16) } : { date: null, time: null };
const fmtAt = (d, t) => `${d.slice(0, 5)} ${t}`;
const minutes = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const numOrNull = s => { const v = String(s ?? "").trim().replace(",", "."); return v === "" ? null : Number(v); };
const str = v => v == null ? "" : tidy(v);

/* ---------- weight scaling ----------
   The base weight is the grams named in each top-level "+" part of the
   quantity, e.g. "3 ביצים (124 גרם) + 18 גרם חמאה" -> 142. Changing the weight
   scales every number in the quantity (not percentages) and the four macros. */
const GRAM_RE = /(\d+(?:[.,]\d+)?)\s*(?:גרם|גר['׳]?|ג['׳]|grams?|gr?)(?![A-Za-z֐-׿])/i;
const NUM_RE = /\d+(?:[.,]\d+)?(?![\d.,]*\s*%)/g;

function topLevelParts(q) {
  const out = []; let depth = 0, cur = "";
  for (const ch of q) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "+" && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function gramsIn(q) {
  if (!q) return null;
  let total = 0, found = false;
  for (const p of topLevelParts(q)) { const m = GRAM_RE.exec(p); if (m) { total += num(m[1]); found = true; } }
  return found && total > 0 ? total : null;
}

/* ---------- state ---------- */
const EMPTY_DAY = { date: "", count: 0, totals: { net_carbs_g: 0, calories: null, fat_g: null, protein_g: null, fasting_hours: null },
  goal: 20, goal_source: "default", remaining: 20, over_goal: false, entries: [], fasts: [], active_fast: null, body: null };

function loadTarget() {
  try { const v = localStorage.getItem("keto.fastTarget"); return v === null ? 16 : +v || 0; } catch (e) { return 16; }
}
function loadRange() {
  try { const v = localStorage.getItem("keto.insightsRange"); return ["7", "30", "90", "all"].includes(v) ? v : "30"; } catch (e) { return "30"; }
}
function saveRange(v) { try { localStorage.setItem("keto.insightsRange", v); } catch (e) { /* private mode */ } }
function saveTarget(v) { try { localStorage.setItem("keto.fastTarget", String(v)); } catch (e) { /* private mode */ } }

/* Glucose is stored in mmol/L; mg/dL is a display choice remembered per browser. */
const MGDL = 18.016;
function loadGluUnit() { try { return localStorage.getItem("keto.glucoseUnit") === "mgdl" ? "mgdl" : "mmol"; } catch (e) { return "mmol"; } }
function saveGluUnit(u) { try { localStorage.setItem("keto.glucoseUnit", u); } catch (e) { /* private mode */ } }
const gluUnitLabel = u => u === "mgdl" ? "mg/dL" : "mmol/L";
// mmol/L -> the number shown in unit u (mg/dL as a whole number).
const gluShow = (mmol, u = S.gluUnit) => u === "mgdl" ? String(Math.round(mmol * MGDL)) : g(mmol);
const gluToMmol = (v, u = S.gluUnit) => u === "mgdl" ? Math.round(v / MGDL * 1000) / 1000 : v;

function blankForm(keep) {
  return Object.assign({ item: "", quantity: "", weight: "", base: null, net_carbs_g: "", calories: "", fat_g: "", protein_g: "",
    date: "", time: hm(now()), meal: "", fasting_hours: "", notes: "", suggest: false }, keep || {});
}

const hashView = () => ["insights", "coach"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "day";

const S = {
  date: today(),
  view: hashView(),
  ins: { range: loadRange(), data: null, err: "", seq: 0, review: null },
  ai: { enabled: false, model: null, vision: false },
  aiFood: null,                                           // set below (blankAiFood)
  coach: { chat: null, list: [], busy: false, err: "", retry: false, draft: "", seq: 0 },
  day: null, week: null,
  top: [], foods: [], meals: [], sugg: [],
  fastTarget: loadTarget(),
  gluUnit: loadGluUnit(),
  pendingFastHours: null,
  measure: null,              // the measurement being added or edited
  imp: { text: "", res: null, err: "", busy: false },     // hours of a fast just stopped, for the meal that breaks it
  seq: 0,
  ui: { sheet: null, expanded: null, editingId: null, goalEdit: false, fastEditId: null, toast: null,
        copyIds: [], copyTarget: null, error: "", busy: false,
        open: { week: false, fast: false, body: false, notes: false, form: false } },
  form: blankForm(),
};
const day = () => S.day || EMPTY_DAY;
const entryById = id => day().entries.find(x => x.id === id);

/* ---------- API ---------- */
function api(url, opts) {
  return fetch(url, opts).then(r => r.json().catch(() => ({})).then(body => {
    if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { body });
    return body;
  }));
}
const send = (method, url, body) => api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const q = s => encodeURIComponent(s);

function load() {
  const seq = ++S.seq, date = S.date;
  return Promise.all([
    api(`/api/day?date=${q(date)}`),
    api(`/api/days?n=7&end=${q(date)}`).catch(() => null),
  ]).then(([d, w]) => {
    if (seq !== S.seq) return;
    S.day = d; S.week = w; S.first = d.first_date;
    render();
    slideIn();
  }).catch(e => { if (seq === S.seq) { slideIn(); toast(e.message, null, null, true); } });
}

function loadLists() {
  api("/api/foods?top=8").then(top => { S.top = top; paint("quick", renderQuickLog()); }).catch(() => {});
  api("/api/foods").then(foods => { S.foods = foods; }).catch(() => {});
  api("/api/meals").then(meals => { S.meals = meals; }).catch(() => {});
}

/* ---------- derived numbers ---------- */
function totalCarbs(entries) { return entries.reduce((a, x) => a + (+x.net_carbs_g || 0), 0); }
function eatingWindow(entries) {
  const times = entries.filter(x => x.time && ((x.calories || 0) > 0 || x.net_carbs_g > 0)).map(x => x.time).sort();
  if (!times.length) return null;
  const a = times[0], b = times[times.length - 1];
  return { from: a, to: b, mins: minutes(b) - minutes(a) };
}
function fastHours(f) {
  return f.end_date ? f.hours : (Date.now() - Date.parse(f.start_at)) / 3.6e6;
}
// The meal of this day's latest entry logged up to two hours before `time`.
function guessMeal(time) {
  if (!time) return null;
  const t = minutes(time);
  let best = null;
  for (const x of day().entries) {
    if (!x.meal || !x.time) continue;
    const d = t - minutes(x.time);
    if (d >= 0 && d <= 120 && (!best || d < best.d)) best = { d, meal: x.meal };
  }
  return best ? best.meal : null;
}

/* =========================================================================
   Renderers — each returns HTML for one region; paint() puts it in place.
   ========================================================================= */
function paint(id, html) { document.getElementById(id).innerHTML = html; }

function render() {
  const d = day();
  document.body.dataset.view = S.view;
  paint("tabs", renderTabs());
  paint("insights", S.view === "insights" ? renderInsights() : "");
  paint("coach", S.view === "coach" ? renderCoach() : "");
  paint("nav", renderNav());
  document.getElementById("glance").className = "glance " + (d.over_goal ? "is-over" : "is-under");
  paint("glance", renderGlance(d));
  paint("quick", renderQuickLog());
  paint("log", renderEntries(d));
  paint("more", renderWeek() + renderFasting(d) + renderBody(d) + renderNotes(d));
  paint("pinbar", renderPinbar(d));
  paint("sheet", renderSheet(d));
  paint("toast", renderToast());
}

function renderGlance(d) { return renderHero(d) + renderGoal(d) + renderFacts(d) + renderFastStrip(d); }

function renderNav() {
  const isToday = S.date === today(), isFirst = !!S.first && !after(S.date, S.first);
  return `
    <button type="button" class="icon-btn" data-act="day" data-n="-1" aria-label="Previous day" ${isFirst ? "disabled" : ""}>&lsaquo;</button>
    <h1><span class="num">${S.date}</span><small>${weekday(S.date, "long")}</small></h1>
    <button type="button" class="icon-btn" data-act="day" data-n="1" aria-label="Next day" ${isToday ? "disabled" : ""}>&rsaquo;</button>
    <button type="button" class="btn" data-act="today" ${isToday ? "disabled" : ""}>Today</button>`;
}

function renderHero(d) {
  const c = d.totals.net_carbs_g || 0, over = d.over_goal;
  const pct = Math.min(c / d.goal, 1) * 100;
  return `
    <p class="eyebrow net-label">Net carbs</p>
    <p class="hero">
      <span><span class="hero-num num">${g(c)}</span><span class="hero-goal">/ ${g(d.goal)} g</span></span>
      <span class="hero-left tone"><b class="num">${g(Math.abs(d.goal - c))} g</b><span class="eyebrow">${over ? "over goal" : "remaining"}</span></span>
    </p>
    <div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div>`;
}

function renderGoal(d) {
  if (S.ui.goalEdit) return `
    <form class="goal-edit" data-form="goal" novalidate>
      <label class="field">Goal for ${S.date.slice(0, 5)}, g<input name="goal" inputmode="decimal" value="${g(d.goal)}" required></label>
      <button class="btn btn-primary">Save</button>
      ${d.goal_source === "set" ? `<button type="button" class="btn" data-act="goal-inherit">Use carried-over goal</button>` : ""}
      <button type="button" class="link" data-act="goal-cancel">Cancel</button>
      <p class="error" style="flex-basis:100%">${esc(S.ui.goalError || "")}</p>
    </form>`;
  const src = { set: "set for this day", inherited: "carried over", default: "default" }[d.goal_source];
  return `<p class="goal">Goal ${g(d.goal)} g, ${src}<button type="button" class="link" data-act="goal-edit">Change</button></p>`;
}

// Macros with their share of energy (fat 9 kcal/g, protein and carbs 4), then
// the eating window and fasting hours.
function renderFacts(d) {
  if (!d.count) return "";
  const t = d.totals;
  const fatK = (t.fat_g || 0) * 9, proK = (t.protein_g || 0) * 4, carbK = (t.net_carbs_g || 0) * 4;
  const sum = fatK + proK + carbK;
  const pc = k => sum > 0 ? ` (${Math.round(k / sum * 100)}%)` : "";
  const w = eatingWindow(d.entries);
  const second = [
    w ? `<span>Eating ${w.from}–${w.to}${w.mins > 0 ? ` (${dur(w.mins / 60)})` : ""}</span>` : "",
    t.fasting_hours != null ? `<span>${g(t.fasting_hours)} h fasting</span>` : "",
  ].filter(Boolean).join(" · ");
  return `
    <p class="facts num"><span>${t.calories == null ? "–" : kcal(t.calories)} kcal</span> · <span>fat ${t.fat_g == null ? "–" : Math.round(t.fat_g) + " g" + pc(fatK)}</span> · <span>protein ${t.protein_g == null ? "–" : Math.round(t.protein_g) + " g" + pc(proK)}</span> · <span>carbs${sum > 0 ? pc(carbK) : ` ${g(t.net_carbs_g)} g`}</span></p>
    ${second ? `<p class="facts num">${second}</p>` : ""}`;
}

// "ends in 6:27 · 14:30", or how long ago the target was reached.
function targetText(f) {
  const h = fastHours(f), target = S.fastTarget;
  if (!target) return "no target";
  return h < target
    ? `ends in ${hmm(target - h)} · ${clockAt(Date.parse(f.start_at) + target * 3.6e6)}`
    : `${target} h reached ${hmm(h - target)} ago`;
}

function renderFastStrip(d) {
  if (S.date !== today()) return renderFastHistory(d);
  const f = d.active_fast;
  if (!f) {
    const ended = d.fasts[d.fasts.length - 1];
    const timed = d.entries.filter(x => x.time);
    const last = timed.length ? timed[timed.length - 1].time : null;
    const note = ended ? ` · last fast ${g(ended.hours)} h, ended ${ended.end_time}` : last ? ` · last food ${last}` : "";
    return `<div class="fast off"><span>Not fasting${note}</span><button type="button" class="btn" data-act="fast-start">Start fast</button></div>`;
  }
  const h = fastHours(f), target = S.fastTarget;
  const pct = target ? Math.min(h / target, 1) * 100 : 0;
  const left = targetText(f);
  return `
    <div class="fast on" aria-live="off">
      <span class="fast-now"><span class="eyebrow">Fasting</span><span class="fast-time num">${dur(h)}</span></span>
      <button type="button" class="btn" data-act="fast-stop">Stop fast</button>
      ${target ? `<div class="meter thin ink" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ""}
      <div class="fast-meta num"><span>since ${fmtAt(f.start_date, f.start_time)}${S.ui.fastAdjust ? "" : `<button type="button" class="link" data-act="fast-adjust">Adjust start</button>`}</span><span>${left}</span></div>
      ${S.ui.fastAdjust ? renderFastAdjust(f) : ""}
    </div>`;
}

// Move the running fast's start back, for when Start was pressed late.
function renderFastAdjust(f) {
  const shifts = [-15, -30, -60].map(m => `<button type="button" class="btn" data-act="fast-shift" data-m="${m}">${m === -60 ? "−1 h" : `−${-m} m`}</button>`).join("");
  return `
    <form class="fast-adjust" data-form="fast-start-time" data-id="${f.id}" novalidate>
      <label class="field">Started at<input type="datetime-local" name="start" value="${toLocal(f.start_date, f.start_time)}" max="${isoLocal(now())}" required></label>
      <div class="row-btns">${shifts}</div>
      <div class="row-btns"><button class="btn btn-primary">Save</button><button type="button" class="link" data-act="fast-adjust-cancel">Cancel</button></div>
      <p class="error">${esc(S.ui.fastError || "")}</p>
    </form>`;
}

/* ---------- fasting on a day other than today ----------
   Fasts from the fasts table that overlap the day; for older days logged
   before the fast tracker, the fasting_hours on the entry that broke a fast. */
function daySegments(d) {
  const iso = dmyToIso(S.date), isToday = S.date === today();
  const segs = [];
  for (const f of d.day_fasts || []) {
    const from = dmyToIso(f.start_date) < iso ? 0 : minutes(f.start_time);
    const to = f.end_date ? (dmyToIso(f.end_date) > iso ? 1440 : minutes(f.end_time))
      : (isToday ? minutes(hm(now())) : 1440);
    segs.push({ from, to, f });
  }
  // An entry's fasting_hours is the same fast as a tracked one ending this day.
  if (!segs.some(s => s.f.end_date === S.date)) {
    for (const x of d.entries) {
      if (!x.fasting_hours || !x.time) continue;
      const to = minutes(x.time);
      segs.push({ from: Math.max(0, to - x.fasting_hours * 60), to, entry: x });
    }
  }
  return segs.sort((a, b) => a.from - b.from);
}

function fastLine(seg) {
  if (seg.entry) return `Broke a ${g(seg.entry.fasting_hours)} h fast at ${seg.entry.time}`;
  const f = seg.f, startsHere = f.start_date === S.date, endsHere = f.end_date === S.date;
  if (!f.end_date) return startsHere ? `Started ${f.start_time} · running ${hmm(fastHours(f))}`
    : `Fasting all day · running since ${fmtAt(f.start_date, f.start_time)}`;
  const h = `${g(f.hours)} h fast`;
  if (startsHere && endsHere) return `${f.start_time}–${f.end_time} · ${h}`;
  if (endsHere) return `Ended ${f.end_time} · ${h} since ${fmtAt(f.start_date, f.start_time)}`;
  if (startsHere) return `Started ${f.start_time} · ${h} until ${fmtAt(f.end_date, f.end_time)}`;
  return `Fasting all day · ${h}, ${fmtAt(f.start_date, f.start_time)} → ${fmtAt(f.end_date, f.end_time)}`;
}

function renderFastHistory(d) {
  const segs = daySegments(d);
  if (!segs.length) return `<div class="fast off"><span>No fast recorded this day</span></div>`;
  const longest = Math.max(...segs.map(s => s.entry ? s.entry.fasting_hours : fastHours(s.f)));
  const bars = segs.map(s => `<i style="left:${s.from / 14.4}%;width:${Math.max(0, s.to - s.from) / 14.4}%"></i>`).join("");
  const food = d.entries.filter(x => x.time && ((x.calories || 0) > 0 || x.net_carbs_g > 0))
    .map(x => `<b style="left:${minutes(x.time) / 14.4}%"></b>`).join("");
  const fasted = segs.reduce((a, s) => a + Math.max(0, s.to - s.from), 0) / 60;
  return `
    <div class="fast hist">
      <span class="fast-now"><span class="eyebrow">Fasting</span><span class="fast-time num">${g(longest)} h</span></span>
      <ul class="fast-lines num">${segs.map(s => `<li>${fastLine(s)}</li>`).join("")}</ul>
      <div class="daybar" role="img" aria-label="Fasted ${hmm(fasted)} of this day">${bars}${food}</div>
      <div class="daybar-ticks num" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <p class="fast-meta"><span>fasted ${hmm(fasted)} of this day</span><span>marks = food</span></p>
    </div>`;
}

function renderQuickLog() {
  if (!S.top.length) return "";
  const chips = S.top.map((x, i) =>
    `<button type="button" class="chip" data-act="quick" data-i="${i}" aria-label="Log ${esc(x.item)}, ${g(x.net_carbs_g)} g net carbs">${ut(x.item)}<span class="num">${g(x.net_carbs_g)} g</span></button>`).join("");
  return `<div class="sec-h"><h2>Log again</h2></div><div class="chips">${chips}</div>`;
}

function renderEntries(d) {
  if (!S.day) return `<div class="sec-h"><h2>Log</h2></div>`;
  if (!d.entries.length) return `<div class="sec-h"><h2>Log</h2></div><p class="empty">No entries.</p>`;
  const groups = [];
  for (const x of d.entries) {                     // server order: chronological, untimed last
    const last = groups[groups.length - 1];
    if (last && last.meal === x.meal) last.rows.push(x); else groups.push({ meal: x.meal, rows: [x] });
  }
  const body = groups.map(gr => (gr.meal ? `
    <div class="meal-h">
      <h3 dir="auto">${esc(gr.meal)}</h3>
      <span class="num">${g(totalCarbs(gr.rows))} g</span>
      <button type="button" class="link" data-act="copy-some" data-ids="${gr.rows.map(x => x.id).join(",")}">Copy</button>
    </div>` : "") + `<ul class="rows">${gr.rows.map(renderRow).join("")}</ul>`).join("");
  return `
    <div class="sec-h"><h2>Log<span class="log-count">${d.entries.length} ${d.entries.length === 1 ? "entry" : "entries"}</span></h2>
      <button type="button" class="link" data-act="copy-open">Copy entries to another day</button></div>
    ${body}`;
}

function renderRow(x) {
  const open = S.ui.expanded === x.id, editing = S.ui.editingId === x.id;
  const macros = [`${x.calories == null ? "–" : kcal(x.calories)} kcal`, `F ${x.fat_g == null ? "–" : g(x.fat_g)}`, `P ${x.protein_g == null ? "–" : g(x.protein_g)}`,
    x.fasting_hours ? `${g(x.fasting_hours)} h fast` : ""].filter(Boolean).join(" · ");
  return `
    <li class="row${open ? " open" : ""}${editing ? " editing" : ""}">
      <button type="button" class="row-main" data-act="expand" data-id="${x.id}" aria-expanded="${open}">
        <span class="t num">${x.time ? x.time : `<span class="none">–</span>`}${x.fasting_hours ? `<span class="brk">ends fast</span>` : ""}</span>
        <span><span class="it" dir="auto">${esc(x.item)}</span>${x.quantity ? `<span class="q" dir="auto">${esc(x.quantity)}</span>` : ""}</span>
        <span class="c num">${g(x.net_carbs_g)}<small> g</small></span>
      </button>
      ${open || editing ? `
      <div class="row-more">
        ${editing ? `<p class="tag">Editing</p>` : ""}
        ${x.notes ? `<p class="notes" dir="auto">${esc(x.notes)}</p>` : ""}
        <p class="num">${macros}${x.source === "mcp" ? ` · <span class="by">added by agent</span>` : ""}</p>
        <div class="row-btns">
          <button type="button" class="btn" data-act="edit" data-id="${x.id}">Edit</button>
          <button type="button" class="btn" data-act="log-again" data-id="${x.id}">Log again now</button>
          <button type="button" class="btn btn-danger" data-act="delete" data-id="${x.id}">Delete</button>
        </div>
      </div>` : ""}
    </li>`;
}

function renderWeek() {
  const w = S.week;
  if (!w) return "";
  const cols = w.days.map(x => ({ date: x.date, carbs: x.count ? x.totals.net_carbs_g : null, goal: x.goal, over: x.over_goal }));
  const max = Math.max(...cols.map(c => Math.max(c.carbs ?? 0, c.goal * 1.25)));
  const html = cols.map(c => {
    const none = c.carbs == null, over = !none && c.over;
    const label = `${weekday(c.date, "short").slice(0, 2)} ${c.date.slice(0, 2)}`;
    const sr = `${weekday(c.date, "long")} ${c.date}: ${none ? "no entries" : `${g(c.carbs)} of ${g(c.goal)} g${over ? ", over goal" : ""}`}`;
    return `<button type="button" class="day${c.date === S.date ? " cur" : ""}${over ? " over" : ""}${none ? " none" : ""}" data-act="goto" data-date="${c.date}" aria-label="${sr}"${c.date === S.date ? ' aria-current="date"' : ""}${S.first && after(S.first, c.date) ? " disabled" : ""}>
      <span class="v num" aria-hidden="true">${none ? "–" : g(c.carbs)}</span>
      <span class="plot" aria-hidden="true"><i style="height:${(c.carbs ?? 0) / max * 100}%"></i><b style="bottom:${c.goal / max * 100}%"></b></span>
      <span class="lbl" aria-hidden="true">${label}</span></button>`;
  }).join("");
  const sum = w.logged_days ? `avg ${g(w.average_net_carbs_g)} g · ${w.within_goal_days} of ${w.logged_days} within goal` : "no entries this week";
  const streak = `streak ${w.streak.current} day${w.streak.current === 1 ? "" : "s"}, best ${w.streak.best}`;
  return `
    <details data-sec="week"${S.ui.open.week ? " open" : ""}>
      <summary><span class="eyebrow">Week</span><span class="sum num">${sum}</span></summary>
      <div class="panel">
        <div class="week">${html}</div>
        <p class="muted num">${w.logged_days ? `7-day avg ${g(w.average_net_carbs_g)} g · ${w.within_goal_days} of ${w.logged_days} days within goal · ` : ""}${streak}</p>
      </div>
    </details>`;
}

function renderFasting(d) {
  const f = d.active_fast;
  const list = (d.day_fasts || []).map(x => {
    const h = fastHours(x);
    const text = x.end_date
      ? `${g(h)} h fast · ${fmtAt(x.start_date, x.start_time)} → ${fmtAt(x.end_date, x.end_time)}`
      : `Running · ${dur(h)} since ${fmtAt(x.start_date, x.start_time)}`;
    const editing = S.ui.fastEditId === x.id;
    const max = isoLocal(now());
    return `<li><span class="num">${text}${x.notes ? ` · ${ut(x.notes)}` : ""}</span>
      <button type="button" class="btn" data-act="fast-edit" data-id="${x.id}" aria-expanded="${editing}">Edit</button>
      <button type="button" class="btn btn-danger" data-act="fast-delete" data-id="${x.id}">Delete</button>
      ${editing ? `<form class="fast-edit" data-form="fast" data-id="${x.id}" novalidate>
        <div class="grid2">
          <label class="field">Start<input type="datetime-local" name="start" value="${toLocal(x.start_date, x.start_time)}" max="${max}" required></label>
          <label class="field">End${x.end_date ? "" : " (empty while running)"}<input type="datetime-local" name="end" value="${toLocal(x.end_date, x.end_time)}" max="${max}"></label>
        </div>
        <label class="field">Notes<input name="notes" dir="auto" value="${esc(x.notes ?? "")}"></label>
        <div class="row-btns"><button class="btn btn-primary">Save</button><button type="button" class="link" data-act="fast-edit" data-id="${x.id}">Cancel</button></div>
        <p class="error">${esc(S.ui.fastError || "")}</p>
      </form>` : ""}</li>`;
  }).join("");
  const targets = [0, 12, 14, 16, 18, 20, 24].map(t => `<option value="${t}"${t === S.fastTarget ? " selected" : ""}>${t ? t + " h" : "None"}</option>`).join("");
  const sum = f ? `${dur(fastHours(f))} · ${S.fastTarget ? targetText(f) : "no target"}`
    : d.fasts.length ? `last ${g(d.fasts[d.fasts.length - 1].hours)} h` : "not fasting";
  return `
    <details data-sec="fast"${S.ui.open.fast ? " open" : ""}>
      <summary><span class="eyebrow">Fasting</span><span class="sum num">${sum}</span></summary>
      <form class="panel" data-form="fast-toggle" novalidate>
        <div class="grid2">
          <label class="field">${f ? "Stopped at" : "Started at"}<input type="datetime-local" name="at" value="${isoLocal(now())}" max="${isoLocal(now())}"></label>
          <label class="field">Target<select name="target" data-act-change="target">${targets}</select></label>
        </div>
        <div class="row-btns"><button class="btn btn-primary">${f ? "Stop fasting" : "Start fasting"}</button></div>
        ${list ? `<ul class="fasts">${list}</ul>` : ""}
      </form>
    </details>`;
}

const MEASURE = [
  // field, label, unit, input mode
  ["weight_kg", "Weight", "kg"],
  ["ketones_mmol", "Ketones", "mmol/L"],
  ["pulse", "Pulse", "bpm"],
];
// "82.4 kg · BP 121/79 · pulse 62 · ketones 1.8 · glucose 4.9"
function measureText(m) {
  return [m.weight_kg != null && `${g(m.weight_kg)} kg`, m.bp_sys != null && `BP ${g(m.bp_sys)}/${g(m.bp_dia)}`,
    m.pulse != null && `pulse ${g(m.pulse)}`, m.ketones_mmol != null && `ketones ${g(m.ketones_mmol)}`,
    m.glucose_mmol != null && `glucose ${gluShow(m.glucose_mmol)}${S.gluUnit === "mgdl" ? " mg/dL" : ""}`].filter(Boolean).join(" · ");
}

function renderBody(d) {
  const b = d.body;
  if (!b) return "";
  const sum = [measureText(b), b.gki != null && `GKI ${g(b.gki)}`, b.water_ml && `${kcal(b.water_ml)} ml water`]
    .filter(Boolean).join(" · ") || "no measurements";
  const delta = b.weight_change_kg;
  const stats = [
    delta != null ? `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${g(Math.abs(delta))} kg since ${b.previous_weight.date.slice(0, 5)}` : "",
    b.gki != null ? `GKI ${g(b.gki)}, ${b.gki_band}` : "",
  ].filter(Boolean).join(" · ");
  const ws = b.weights;
  let spark = "";
  if (ws.length >= 2) {
    const vals = ws.map(w => w.weight_kg);
    const lo = Math.min(...vals) - .2, hi = Math.max(...vals) + .2;
    const pts = ws.map((w, i) => `${(i / (ws.length - 1) * 100).toFixed(2)},${((hi - w.weight_kg) / (hi - lo) * 40 + 4).toFixed(2)}`);
    const first = ws[0], lastW = ws[ws.length - 1];
    spark = `<div>
      <svg class="spark" viewBox="0 0 100 48" preserveAspectRatio="none" role="img" aria-label="Weight, last 30 days: ${g(first.weight_kg)} to ${g(lastW.weight_kg)} kg"><polyline points="${pts.join(" ")}"/></svg>
      <p class="muted num" style="display:flex;justify-content:space-between"><span>${first.date.slice(0, 5)} · ${g(first.weight_kg)} kg</span><span>30 days</span><span>${g(lastW.weight_kg)} kg</span></p>
    </div>`;
  }
  const list = b.measurements.map(m => `<li>
      <span class="t num">${m.time || `<span class="none">–</span>`}</span>
      <span class="mv num">${measureText(m)}${m.notes ? `<small>${ut(m.notes)}</small>` : ""}</span>
      <button type="button" class="btn" data-act="measure-edit" data-id="${m.id}">Edit</button>
      <button type="button" class="btn btn-danger" data-act="measure-delete" data-id="${m.id}">Delete</button></li>`).join("");
  return `
    <details data-sec="body"${S.ui.open.body ? " open" : ""}>
      <summary><span class="eyebrow">Body</span><span class="sum num">${sum}</span></summary>
      <div class="panel">
        ${list ? `<ul class="measures">${list}</ul>` : `<p class="muted">No measurements this day.</p>`}
        <div class="row-btns"><button type="button" class="btn btn-primary" data-act="measure-add">Add measurement</button></div>
        ${stats ? `<p class="num">${stats}</p>` : ""}
        ${spark}
        <div class="water">
          <p class="num">Water <b>${kcal(b.water_ml || 0)} ml</b></p>
          <button type="button" class="btn" data-act="water" data-ml="250">+250</button>
          <button type="button" class="btn" data-act="water" data-ml="500">+500</button>
          <button type="button" class="btn" data-act="water" data-ml="-250" aria-label="Remove 250 ml">−250</button>
        </div>
        <p class="error">${esc(S.ui.bodyError || "")}</p>
      </div>
    </details>`;
}

/* ---------- notes and symptoms ---------- */
const SYMPTOMS = ["Headache", "Nausea", "Tiredness", "Dizziness", "Cramps", "Brain fog", "Hunger", "Cravings", "Constipation", "Poor sleep", "Heart racing"];
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
// Usual symptoms first, then any other names used before or picked now.
function symptomChoices(picked) {
  const out = SYMPTOMS.slice();
  for (const n of [...(day().symptom_names || []), ...picked]) if (!out.some(x => sameName(x, n))) out.push(n);
  return out;
}
const WORKOUTS = ["Run", "Walk", "Gym", "Bike", "Swim", "Yoga", "Hike"];
function workoutChoices(picked) {
  const out = WORKOUTS.slice();
  for (const n of [...(day().workout_names || []), picked || ""]) if (n && !out.some(x => sameName(x, n))) out.push(n);
  return out;
}
const workoutText = n => n.workout ? `${n.workout}${n.minutes != null ? ` · ${g(n.minutes)} min` : ""}` : "";
const noteTags = n => (n.workout ? `<span class="sym wk">${ut(n.workout)}${n.minutes != null ? ` · <span class="num">${g(n.minutes)} min</span>` : ""}</span>` : "")
  + n.symptoms.map(x => `<span class="sym">${ut(x)}</span>`).join("");

function renderNotes(d) {
  const notes = d.notes || [];
  const names = [];
  for (const n of notes) for (const x of n.symptoms) if (!names.some(y => sameName(x, y))) names.push(x);
  const texts = notes.filter(n => n.notes && !n.workout).length;
  const sum = [notes.filter(n => n.workout).map(n => esc(workoutText(n))).join(", "), names.map(esc).join(", "),
    texts && `${texts} ${texts === 1 ? "note" : "notes"}`].filter(Boolean).join(" · ") || "nothing noted";
  const list = notes.map(n => `<li>
      <span class="t num">${n.time || `<span class="none">–</span>`}</span>
      <span class="mv">${noteTags(n)}${n.notes ? `<small dir="auto">${esc(n.notes)}</small>` : ""}</span>
      <button type="button" class="btn" data-act="note-edit" data-id="${n.id}">Edit</button>
      <button type="button" class="btn btn-danger" data-act="note-delete" data-id="${n.id}">Delete</button></li>`).join("");
  return `
    <details data-sec="notes"${S.ui.open.notes ? " open" : ""}>
      <summary><span class="eyebrow">Notes</span><span class="sum">${sum}</span></summary>
      <div class="panel">
        ${list ? `<ul class="measures notes">${list}</ul>` : `<p class="muted">No workouts, symptoms or notes this day.</p>`}
        <div class="row-btns">
          <button type="button" class="btn btn-primary" data-act="workout-add">Add workout</button>
          <button type="button" class="btn" data-act="note-add">Add symptoms or a note</button>
        </div>
      </div>
    </details>`;
}

function renderNoteForm() {
  const n = S.note, editing = n.id != null;
  const showWorkout = n.mode === "workout" || !!n.workout, showFeel = n.mode === "feel" || n.symptoms.length > 0;
  const kinds = workoutChoices(n.workout).map(x =>
    `<button type="button" class="chip" data-act="note-kind" data-name="${esc(x)}" aria-pressed="${!!n.workout && sameName(x, n.workout)}">${ut(x)}</button>`).join("");
  const chips = symptomChoices(n.symptoms).map(x =>
    `<button type="button" class="chip" data-act="note-sym" data-name="${esc(x)}" aria-pressed="${n.symptoms.some(y => sameName(x, y))}">${ut(x)}</button>`).join("");
  const title = editing ? (n.mode === "workout" ? "Edit workout" : "Edit note") : n.mode === "workout" ? "Add workout" : "How do you feel?";
  return `
    <div class="sheet-h"><h2 id="sheet-title">${title}</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">&times;</button></div>
    <form class="form" data-form="note" autocomplete="off" novalidate>
      <div class="grid2">
        <label class="field">Date<input type="date" name="date" value="${dmyToIso(n.date)}" max="${dmyToIso(today())}" required></label>
        <label class="field">Time<input type="time" name="time" value="${esc(n.time || "")}"></label>
      </div>
      ${showWorkout ? `
      <div class="syms wk" role="group" aria-label="Workout">${kinds}</div>
      <div class="grid2">
        <label class="field">Another kind<input name="kind" dir="auto" maxlength="40" value="${esc(n.kind)}"></label>
        <label class="field">Minutes<input name="minutes" inputmode="decimal" value="${esc(n.minutes)}"></label>
      </div>` : ""}
      ${showFeel ? `
      <div class="syms" role="group" aria-label="Symptoms">${chips}</div>
      <label class="field">Another symptom<input name="other" dir="auto" maxlength="40" enterkeyhint="done" placeholder="Separate several with commas" value="${esc(n.other)}"></label>` : ""}
      <label class="field">${n.mode === "workout" ? "Details" : "Note"}<textarea name="notes" dir="auto" rows="3" maxlength="2000"${n.mode === "workout" ? ` placeholder="5 km at 6:30 min/km, how it felt…"` : ""}>${esc(n.notes || "")}</textarea></label>
      <p class="error" id="form-error" role="alert">${esc(S.ui.error)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
        <button class="btn btn-primary"${S.ui.busy ? " disabled" : ""}>${editing ? "Save" : "Add"}</button>
      </div>
    </form>`;
}
// n: a saved note to edit; mode: "workout" or "feel" for a new one.
function openNote(n, mode) {
  S.note = n ? { id: n.id, mode: n.workout ? "workout" : "feel", date: n.date, time: n.time, symptoms: n.symptoms.slice(), notes: n.notes || "", other: "",
      workout: n.workout || "", kind: "", minutes: str(n.minutes) }
    : { id: null, mode, date: S.date, time: S.date === today() ? hm(now()) : "", symptoms: [], notes: "", other: "", workout: "", kind: "", minutes: "" };
  S.ui.sheet = "note"; S.ui.error = ""; S.ui.busy = false;
  render();
}
function noteText(n) { return [workoutText(n), n.symptoms.join(", "), n.notes && (n.symptoms.length || n.workout ? "note" : "Note")].filter(Boolean).join(" · "); }
const notePayload = x => ({ date: x.date, time: x.time, symptoms: x.symptoms, notes: x.notes, workout: x.workout, minutes: x.minutes });
function deleteNote(id) {
  api(`/api/notes/${id}`, { method: "DELETE" }).then(res => {
    const x = res.deleted;
    toast(["Deleted ", { u: noteText(x) }], () => send("POST", "/api/notes", notePayload(x)));
    return load();
  }).catch(fail);
}

function renderPinbar(d) {
  if (S.ui.sheet) return "";
  const c = d.totals.net_carbs_g || 0, over = d.over_goal;
  return `<div class="pinbar-in">
    <span class="left tone${over ? " over" : ""}"><b class="num">${g(Math.abs(d.goal - c))} g</b>${over ? "over" : "left"}</span>
    <button type="button" class="btn" data-act="measure-add">Measure</button>
    <button type="button" class="btn btn-primary" data-act="open-add">Add food</button></div>`;
}

function renderSheet(d) {
  if (!S.ui.sheet) return "";
  const inner = S.ui.sheet === "copy" ? renderCopyPanel(d) : S.ui.sheet === "measure" ? renderMeasureForm(d)
    : S.ui.sheet === "note" ? renderNoteForm() : S.ui.sheet === "import" ? renderImport() : S.ui.sheet === "ai" ? renderAiReview() : renderAddForm(d);
  return `<div class="scrim" data-act="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="grab" aria-hidden="true"></div>${inner}</div>`;
}

function renderAddForm(d) {
  const f = S.form, editing = S.ui.sheet === "edit";
  const editItem = editing && entryById(S.ui.editingId);
  const title = editing ? `Editing: ${ut(editItem ? editItem.item : f.item)}` : `Add food <span class="muted num" style="font-weight:400;font-size:var(--t-sm)">to ${(f.date || S.date).slice(0, 5)}</span>`;
  const base = f.base;
  const portions = base ? [0.5, 1, 1.5, 2].map(p => `<button type="button" class="btn" data-act="portion" data-p="${p}" aria-pressed="${num(f.weight) === +tidy(base.weight * p)}">×${{ 0.5: "½", 1: "1", 1.5: "1½", 2: "2" }[p]}</button>`).join("") : "";
  const meals = S.meals.map(m => `<option value="${esc(m)}"></option>`).join("");
  return `
    <div class="sheet-h"><h2 id="sheet-title">${title}</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">&times;</button></div>
    <form class="form" data-form="entry" autocomplete="off" novalidate>
      ${renderAiBox()}
      <div class="item-wrap">
        <label class="field">Item<input name="item" dir="auto" value="${esc(f.item)}" required role="combobox" aria-expanded="${f.suggest}" aria-controls="sugg" enterkeyhint="done"></label>
        <ul class="sugg" id="sugg" role="listbox"${f.suggest && S.sugg.length ? "" : " hidden"}>${renderSuggestions()}</ul>
      </div>
      <label class="field">Quantity<input name="quantity" dir="auto" value="${esc(f.quantity)}"></label>
      ${base ? `
      <div class="weight">
        <label class="field">${base.grams ? "Weight, g" : "Portions"}<input name="weight" inputmode="decimal" value="${esc(f.weight)}"></label>
        <div class="portions" role="group" aria-label="Portion">${portions}</div>
        <p class="was num">${base.grams ? `was ${tidy(base.grams)} g · scales quantity and all four numbers` : "no grams in quantity · scales by portion"}</p>
      </div>` : ""}
      <div class="grid2">
        <label class="field key">Net carbs, g<input name="net_carbs_g" inputmode="decimal" value="${esc(f.net_carbs_g)}" required></label>
        <label class="field">Calories<input name="calories" inputmode="decimal" value="${esc(f.calories)}"></label>
        <label class="field">Fat, g<input name="fat_g" inputmode="decimal" value="${esc(f.fat_g)}"></label>
        <label class="field">Protein, g<input name="protein_g" inputmode="decimal" value="${esc(f.protein_g)}"></label>
      </div>
      <p class="preview num" id="preview">${renderPreview(d)}</p>
      <details data-sec="form"${S.ui.open.form ? " open" : ""}>
        <summary><b>More</b><span class="sum num" id="more-sum">${renderMoreSummary()}</span></summary>
        <div class="inner">
          <div class="grid2">
            <label class="field">Date<input type="date" name="date" value="${dmyToIso(f.date || S.date)}"></label>
            <label class="field">Time<input type="time" name="time" value="${esc(f.time)}"></label>
            <label class="field">Meal<input name="meal" dir="auto" list="meals" value="${esc(f.meal)}"></label>
            <label class="field">Fasting hours<input name="fasting_hours" inputmode="decimal" value="${esc(f.fasting_hours)}"></label>
          </div>
          <datalist id="meals">${meals}</datalist>
          <label class="field">Notes<textarea name="notes" dir="auto" rows="2">${esc(f.notes)}</textarea></label>
          <fieldset class="calc">
            <legend>Net carbs from a label</legend>
            <div class="grid3">
              <label class="field">Total carbs<input name="calc_total" inputmode="decimal"></label>
              <label class="field">− Fiber<input name="calc_fiber" inputmode="decimal"></label>
              <label class="field">− Sugar alcohols<input name="calc_sa" inputmode="decimal"></label>
            </div>
            <div class="row-btns"><span class="num" id="calc-out">= – g</span><button type="button" class="btn" data-act="calc-use">Use as net carbs</button></div>
          </fieldset>
        </div>
      </details>
      <p class="error" id="form-error" role="alert">${esc(S.ui.error)}</p>
      <div class="sheet-actions">
        ${editing ? `<button type="button" class="btn" data-act="close-sheet">Cancel</button>` : ""}
        <button class="btn btn-primary"${S.ui.busy ? " disabled" : ""}>${editing ? "Save" : "Add"}</button>
      </div>
    </form>`;
}

function updateSuggestions() {
  const qv = S.form.item.trim().toLowerCase();
  const starts = [], rest = [];
  if (qv && S.ui.sheet === "add") {
    for (const x of S.foods) {
      const i = x.item.toLowerCase().indexOf(qv);
      if (i === 0) starts.push(x); else if (i > 0) rest.push(x);
    }
  }
  S.sugg = starts.concat(rest).slice(0, 6);
  if (S.sugg.length === 1 && S.sugg[0].item === S.form.item && S.form.base) S.sugg = [];
}

function renderSuggestions() {
  return S.sugg.map((x, i) => `<li role="option"><button type="button" data-act="pick" data-i="${i}">
      <span class="it">${ut(x.item)}${x.quantity ? ` · ${ut(x.quantity)}` : ""}</span><span class="num">${g(x.net_carbs_g)} g</span>
      <span class="meta num">last ${x.last_date.slice(0, 5)}</span></button></li>`).join("");
}

function renderPreview(d) {
  const target = S.form.date || S.date;
  if (target !== S.date) return `Adds to ${target}`;
  const t = totalCarbs(d.entries.filter(x => x.id !== S.ui.editingId)) + (num(S.form.net_carbs_g) || 0);
  const over = t > d.goal;
  return `After this: <b>${g(t)}</b> / ${g(d.goal)} g, <span class="tone${over ? " over" : ""}">${g(Math.abs(d.goal - t))} g ${over ? "over" : "left"}</span>`;
}
function renderMoreSummary() {
  const f = S.form;
  return [(f.date || S.date).slice(0, 5), f.time, f.meal && ut(f.meal), f.fasting_hours && `${esc(f.fasting_hours)} h fast`, f.notes && "note"].filter(Boolean).join(" · ");
}

function renderMeasureForm(d) {
  const m = S.measure, editing = m.id != null;
  const v = k => m[k] == null ? "" : esc(m[k]);
  const fields = MEASURE.map(([k, label, unit]) =>
    `<label class="field">${label}, ${unit}<input name="${k}" inputmode="decimal" value="${v(k)}"></label>`).join("");
  return `
    <div class="sheet-h"><h2 id="sheet-title">${editing ? "Edit measurement" : "Add measurement"}</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">&times;</button></div>
    <form class="form" data-form="measure" autocomplete="off" novalidate>
      <div class="grid2">
        <label class="field">Date<input type="date" name="date" value="${dmyToIso(m.date)}" max="${dmyToIso(today())}" required></label>
        <label class="field">Time<input type="time" name="time" value="${v("time")}"></label>
      </div>
      <fieldset class="bp"><legend>Blood pressure, mmHg</legend>
        <label class="field">Systolic<input name="bp_sys" inputmode="decimal" value="${v("bp_sys")}"></label>
        <span aria-hidden="true">/</span>
        <label class="field">Diastolic<input name="bp_dia" inputmode="decimal" value="${v("bp_dia")}"></label>
      </fieldset>
      <div class="glu">
        <label class="field"><span>Glucose, <span id="glu-unit">${gluUnitLabel(S.gluUnit)}</span></span><input name="glucose_mmol" inputmode="decimal" value="${m.glucose_mmol == null ? "" : gluShow(m.glucose_mmol)}"></label>
        <div class="seg" role="group" aria-label="Glucose unit">${["mmol", "mgdl"].map(u =>
          `<button type="button" class="btn" data-act="glu-unit" data-u="${u}" aria-pressed="${S.gluUnit === u}">${gluUnitLabel(u)}</button>`).join("")}</div>
      </div>
      <div class="grid2">${fields}</div>
      <label class="field">Notes<input name="notes" dir="auto" value="${v("notes")}"></label>
      <p class="error" id="form-error" role="alert">${esc(S.ui.error)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
        <button class="btn btn-primary"${S.ui.busy ? " disabled" : ""}>${editing ? "Save" : "Add"}</button>
      </div>
    </form>`;
}

function renderImport() {
  const im = S.imp;
  return `
    <div class="sheet-h"><h2 id="sheet-title">Import from sheet</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">&times;</button></div>
    <form class="form" data-form="import" novalidate>
      <p class="muted hint">Paste rows copied from the Google Sheet, columns in this order: date, time, fasting hours, item, quantity, calories, fat, protein, net carbs, notes. Rows whose item starts with <bdi dir="rtl">סה"כ</bdi> are meal totals: they are skipped and name the meal of the rows at the same time. Rows already in the log are skipped.</p>
      <label class="field">Rows<textarea name="text" dir="ltr" rows="7" spellcheck="false" placeholder="30/09/2026&#9;10:00:00&#9;&#9;קפה&#9;…">${esc(im.text)}</textarea></label>
      <div id="imp-preview">${renderImportPreview()}</div>
      <div class="sheet-actions">
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
        <button class="btn btn-primary" id="imp-go"${importReady() ? "" : " disabled"}>${importLabel()}</button>
      </div>
    </form>`;
}
function importReady() { const r = S.imp.res; return !!r && !S.imp.busy && !S.imp.err && !r.errors.length && r.new > 0; }
function importLabel() { const r = S.imp.res; return r && r.new ? `Import ${r.new} ${r.new === 1 ? "row" : "rows"}` : "Import"; }
function renderImportPreview() {
  const im = S.imp, r = im.res;
  if (im.err) return `<p class="error" role="alert">${esc(im.err)}</p>`;
  if (!r) return "";
  const head = [`${r.new} new`, r.duplicates && `${r.duplicates} already in the log`,
    r.totals.length && `${r.totals.length} total ${r.totals.length === 1 ? "row" : "rows"} skipped`].filter(Boolean).join(" · ");
  const errs = r.errors.map(e => `<li>${esc(e)}</li>`).join("");
  const rows = r.rows.map(x => `<li class="${x.duplicate ? "dup" : ""}">
      <span class="num muted">${x.date.slice(0, 5)} ${x.time || "–"}</span>
      <span class="it">${ut(x.item)}${x.meal ? ` <small>${ut(x.meal)}</small>` : ""}${x.fasting_hours ? ` <small class="num">${g(x.fasting_hours)} h fast</small>` : ""}</span>
      <span class="num">${x.duplicate ? "logged" : `${g(x.net_carbs_g)} g`}</span></li>`).join("");
  return `<p class="num" role="status">${head}</p>
    ${errs ? `<ul class="error imp-errors">${errs}</ul>` : ""}
    ${rows ? `<ul class="copy-list imp-rows">${rows}</ul>` : ""}`;
}

function renderCopyPanel(d) {
  const target = S.ui.copyTarget || (S.date === today() ? addDays(S.date, 1) : today());
  const rows = d.entries.map(x => `<li><label>
      <input type="checkbox" name="ids" value="${x.id}"${S.ui.copyIds.includes(x.id) ? " checked" : ""}>
      <span class="num muted">${x.time || "–"}</span><span class="it">${ut(x.item)}${x.quantity ? ` · ${ut(x.quantity)}` : ""}</span><span class="num">${g(x.net_carbs_g)} g</span>
    </label></li>`).join("");
  return `
    <div class="sheet-h"><h2 id="sheet-title">Copy entries</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">&times;</button></div>
    <form class="form" data-form="copy" novalidate>
      <ul class="copy-list">${rows}</ul>
      <div class="grid2">
        <label class="field">To day<input type="date" name="target" value="${dmyToIso(target)}" required></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="keep" checked> Keep times</label>
      </div>
      <p class="error" id="form-error" role="alert">${esc(S.ui.error)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
        <button class="btn btn-primary" id="copy-go"${S.ui.busy ? " disabled" : ""}>${copyLabel()}</button>
      </div>
    </form>`;
}
function copyLabel() {
  const n = S.ui.copyIds.length;
  return `Copy ${n || ""} ${n === 1 ? "entry" : "entries"}`;
}

function renderToast() {
  const t = S.ui.toast;
  if (!t) return "";
  const msg = [].concat(t.msg).map(p => typeof p === "object" ? ut(p.u) : esc(p)).join("");
  return `<div class="toast${t.err ? " err" : ""}" role="status"><span>${msg}</span>${t.undo ? `<button type="button" data-act="undo">Undo</button>` : ""}${t.action ? `<button type="button" data-act="toast-action">${esc(t.action.label)}</button>` : ""}</div>`;
}

/* =========================================================================
   Insights — progress over a range of days, from /api/insights.
   ========================================================================= */
const RANGES = [["7", "7 d"], ["30", "30 d"], ["90", "90 d"], ["all", "All"]];
const CH = {};   // chart name -> { n, line, idx, tip(i), rest } for the scrub readout
const dm = s => s.slice(0, 5);
const thousands = n => Math.round(n).toLocaleString("en-GB");
const signed = (v, f = g) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${f(Math.abs(v))}`;
const dayTag = d => `${weekday(d.date, "short")} ${dm(d.date)}`;
// The next round number at or above x: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten.
function nice(x) {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p;
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => s >= m - 1e-9) * p;
}

function loadInsights() {
  const I = S.ins, seq = ++I.seq;
  return api(`/api/insights?days=${q(I.range)}`).then(r => {
    if (seq !== I.seq) return;
    I.data = r; I.err = ""; S.first = r.first_date;
    paint("insights", renderInsights());
  }).catch(e => { if (seq === I.seq) { I.err = e.message; paint("insights", renderInsights()); } });
}

function setView(v) {
  S.view = v === "insights" || (v === "coach" && S.ai.enabled) ? v : "day";
  if (hashView() !== S.view) history.replaceState(null, "", S.view === "day" ? location.pathname + location.search : "#" + S.view);
  if (S.view !== "day") S.ui.sheet = null;
  if (S.view === "insights") loadInsights(); else if (S.view === "day") load();
  else if (S.coach.chat && S.coach.chat.id && !S.coach.busy) openChat(S.coach.chat.id); else loadChats();
  render();
  if (S.view === "coach") paintCoach(true); else window.scrollTo(0, 0);
}

function renderTabs() {
  return [["day", "Day"], ["insights", "Insights"]].concat(S.ai.enabled ? [["coach", "Coach"]] : []).map(([v, label]) =>
    `<button type="button" role="tab" aria-selected="${S.view === v}" data-act="view" data-view="${v}">${label}</button>`).join("");
}

function chartFrame(name, inner, hi, lo, days, label) {
  const a = days[0], z = days[days.length - 1], mid = days[Math.floor((days.length - 1) / 2)];
  const x = days.length > 6 ? [a, mid, z] : days.length > 1 ? [a, z] : [a];
  return `<div class="chart" role="img" aria-label="${esc(label)}">
    <span class="yax num" aria-hidden="true"><span>${hi}</span><span>${lo}</span></span>
    <div class="plotarea" data-chart="${name}">${inner}<i class="cursor" hidden></i></div>
    <span class="xax num" aria-hidden="true">${x.map(d => `<span>${dm(d.date)}</span>`).join("")}</span></div>`;
}

// One bar per day. o: val(d), tip(d, v), rest, unit, label, cls(d, v), line(d), tone.
function barChart(name, days, o) {
  const vals = days.map(o.val);
  const lines = o.line ? days.map(o.line) : [];
  const top = nice(Math.max(0, ...vals.map(v => v ?? 0), ...lines.map(v => v ?? 0)));
  CH[name] = { n: days.length, tip: i => `${dayTag(days[i])} · ${vals[i] == null ? "nothing logged" : o.tip(days[i], vals[i])}`, rest: o.rest };
  const cols = days.map((d, i) => {
    const v = vals[i], ln = lines[i];
    return `<span class="col${v == null ? " none" : ""}${o.cls ? " " + o.cls(d, v) : ""}"><i style="height:${v == null ? 0 : Math.max(v / top * 100, 1.5)}%"></i>${ln != null ? `<b style="bottom:${ln / top * 100}%"></b>` : ""}</span>`;
  }).join("");
  const dense = days.length > 45 ? " dense" : days.length > 14 ? " mid" : "";
  return chartFrame(name, `<div class="bars ${o.tone || ""}${dense}">${cols}</div>`, `${g(top)}${o.unit ? " " + o.unit : ""}`, "0", days, o.label);
}

// One or two lines over the days that have a reading. series: [{ val(d), cls }]; o: tip(d), rest, fmt, label.
function lineChart(name, days, series, o) {
  const n = days.length, fmt = o.fmt || g;
  const all = [];
  const pts = series.map(s => days.map((d, i) => [i, s.val(d)]).filter(p => p[1] != null));
  pts.forEach(ps => ps.forEach(p => all.push(p[1])));
  const min = Math.min(...all), max = Math.max(...all);
  const step = nice((max - min) / 2 || Math.abs(max) * .02 || 1);
  let lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
  if (hi === lo) { hi += step; lo -= step; }
  const X = i => n > 1 ? i / (n - 1) * 100 : 50, Y = v => (hi - v) / (hi - lo) * 100;
  const idx = [...new Set(pts.flat().map(p => p[0]))].sort((a, b) => a - b);
  CH[name] = { n, line: true, idx, tip: i => `${dayTag(days[i])} · ${o.tip(days[i])}`, rest: o.rest };
  const svg = pts.map((ps, k) => `<polyline class="${series[k].cls || ""}" points="${ps.map(p => `${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`).join(" ")}"/>`).join("");
  const dots = pts.map((ps, k) => ps.length > 31 ? "" : ps.map(p => `<i class="dot ${series[k].cls || ""}" style="left:${X(p[0]).toFixed(2)}%;top:${Y(p[1]).toFixed(2)}%"></i>`).join("")).join("");
  return chartFrame(name, `<svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${svg}</svg>${dots}`, fmt(hi), fmt(lo), days, o.label);
}

const insSection = (name, title, rest, body) => `
  <section class="ins-sec" data-ins="${name}">
    <div class="sec-h"><h2>${title}</h2><p class="readout num" id="ro-${name}">${rest || ""}</p></div>
    ${body}
  </section>`;
const statTile = (label, value, sub, cls) => `<div class="stat${cls ? " " + cls : ""}"><p class="eyebrow">${label}</p><p class="stat-v num">${value}</p><p class="stat-s num">${sub || "&nbsp;"}</p></div>`;

function renderInsights() {
  const I = S.ins, r = I.data;
  const head = `
    <header class="ins-h">
      <h1>Insights</h1>
      <div class="seg" role="group" aria-label="Range">${RANGES.map(([v, label]) =>
        `<button type="button" class="btn" data-act="ins-range" data-range="${v}" aria-pressed="${I.range === v}">${label}</button>`).join("")}</div>
    </header>`;
  if (!r) return head + `<p class="empty">${I.err ? esc(I.err) : "Loading…"}</p>`;
  const s = r.summary, days = r.days, av = s.average, n = s.logged_days;
  const span = days.length;
  const sub = `<p class="ins-sub num">${dm(r.from)} – ${dm(r.to)} · ${span} ${span === 1 ? "day" : "days"}${n ? ` · averages over ${n} full ${n === 1 ? "day" : "days"}, today left out` : ""}</p>`;
  if (!days.some(d => d.count) && !Object.values(s.measurements).some(Boolean) && !s.symptoms.length && !s.workouts.sessions) {
    return head + sub + `<p class="empty">Nothing logged in this range yet.</p>`;
  }
  return head + sub + (I.err ? `<p class="error">${esc(I.err)}</p>` : "")
    + renderInsStats(r) + renderInsReview(r) + renderInsCarbs(r) + renderInsEnergy(r) + renderInsFasting(r) + renderInsBody(r) + renderInsWorkouts(r) + renderInsSymptoms(r) + renderInsFoods(r);
}

function renderInsStats(r) {
  const s = r.summary, av = s.average, n = s.logged_days, w = s.measurements.weight_kg, f = s.fasting;
  const lastGoal = r.days[r.days.length - 1].goal;
  const pct = n ? Math.round(s.within_goal_days / n * 100) : 0;
  return `<div class="stats">
    ${statTile("Avg net carbs", n ? `${g(av.net_carbs_g)} g` : "–", `goal ${g(lastGoal)} g`, n && av.net_carbs_g > lastGoal ? "over" : "good")}
    ${statTile("Within goal", n ? `${pct}%` : "–", n ? `${s.within_goal_days} of ${n} days` : "", n && pct < 50 ? "over" : "good")}
    ${statTile("Streak", `${s.streak.current} ${s.streak.current === 1 ? "day" : "days"}`, `best ${s.streak.best}`)}
    ${statTile("Avg energy", av.calories == null ? "–" : `${thousands(av.calories)}`, "kcal a day")}
    ${statTile("Avg fast", f.average_hours == null ? "–" : `${g(f.average_hours)} h`, f.days ? `longest ${g(f.longest_hours)} h` : "none recorded", "fasting")}
    ${statTile("Weight", w && w.days > 1 ? `${signed(w.change)} kg` : w ? `${g(w.last)} kg` : "–",
      w && w.days > 1 ? `${g(w.first)} → ${g(w.last)} kg` : w ? `one reading, ${dm(w.last_date)}` : "no readings", "body")}
  </div>`;
}

function renderInsCarbs(r) {
  const s = r.summary, n = s.logged_days;
  const rest = n ? `avg ${g(s.average.net_carbs_g)} g · ${s.within_goal_days} of ${n} within goal` : "";
  return insSection("carbs", "Net carbs per day", rest, barChart("carbs", r.days, {
    val: d => d.net_carbs_g, line: d => d.goal, unit: "g", rest,
    cls: d => d.over_goal ? "over" : "",
    tip: (d, v) => `${g(v)} of ${g(d.goal)} g${d.over_goal ? ", over" : ""}`,
    label: `Net carbs per day, ${dm(r.from)} to ${dm(r.to)}. ${rest}`,
  }) + `<p class="legend"><span class="sw line"></span>goal</p>`);
}

function renderInsEnergy(r) {
  const s = r.summary, av = s.average, m = s.macro_pct;
  if (!r.days.some(d => d.calories != null)) return "";
  const rest = av.calories == null ? "" : `avg ${thousands(av.calories)} kcal`;
  const split = m ? `
    <div class="split" role="img" aria-label="Energy: fat ${m.fat}%, protein ${m.protein}%, net carbs ${m.net_carbs}%">
      <i class="fat" style="width:${m.fat}%"></i><i class="pro" style="width:${m.protein}%"></i><i class="carb" style="width:${m.net_carbs}%"></i></div>
    <p class="legend num"><span><span class="sw fat"></span>fat ${m.fat}% · ${Math.round(av.fat_g)} g</span><span><span class="sw pro"></span>protein ${m.protein}% · ${Math.round(av.protein_g)} g</span><span><span class="sw carb"></span>net carbs ${m.net_carbs}% · ${g(av.net_carbs_g)} g</span></p>` : "";
  return insSection("energy", "Energy and macros", rest, barChart("energy", r.days, {
    val: d => d.calories, unit: "kcal", rest, tone: "ink",
    tip: (d, v) => `${thousands(v)} kcal${d.fat_g != null ? ` · fat ${Math.round(d.fat_g)} g` : ""}${d.protein_g != null ? ` · protein ${Math.round(d.protein_g)} g` : ""}`,
    label: `Energy per day, ${dm(r.from)} to ${dm(r.to)}. ${rest}`,
  }) + split);
}

function renderInsFasting(r) {
  const f = r.summary.fasting, e = r.summary.eating, target = S.fastTarget;
  if (!f.days) return insSection("fasting", "Fasting", "", `<p class="empty">No fasts in this range.</p>`);
  const hit = target ? r.days.filter(d => d.fast_hours >= target).length : 0;
  const rest = `avg ${g(f.average_hours)} h${target ? ` · ${hit} of ${f.days} reached ${target} h` : ""}`;
  const eating = e.days ? `<p class="num">Eating window averages ${dur(e.average_window_hours)}, from about ${e.average_first_time} to ${e.average_last_time}.</p>` : "";
  return insSection("fasting", "Fasting hours per day", rest, barChart("fasting", r.days, {
    val: d => d.fast_hours, line: target ? () => target : null, unit: "h", rest, tone: "sky",
    tip: (d, v) => `${dur(v)} fasted`,
    label: `Fasting hours per day, ${dm(r.from)} to ${dm(r.to)}. ${rest}, longest ${g(f.longest_hours)} h`,
  }) + (target ? `<p class="legend"><span class="sw line"></span>${target} h target</p>` : "") + eating);
}

function renderInsBody(r) {
  const st = r.summary.measurements, days = r.days, mg = S.gluUnit === "mgdl";
  const glu = v => +gluShow(v);
  const one = (name, title, stat, unit, val, fmt, cls) => {
    if (!stat) return "";
    const show = fmt || g, u = unit ? " " + unit : "";
    const rest = stat.days > 1 ? `${show(stat.first)} → ${show(stat.last)}${u} · avg ${show(stat.average)}` : `${show(stat.last)}${u} on ${dm(stat.last_date)}`;
    const body = stat.days > 1 ? lineChart(name, days, [{ val, cls }], {
      rest, fmt: v => tidy(v), tip: d => `${show(val(d))}${u}`,
      label: `${title}, ${dm(r.from)} to ${dm(r.to)}: ${rest}`,
    }) : "";
    return insSection(name, title, rest, body);
  };
  let bp = "";
  if (st.bp_sys) {
    const a = st.bp_sys, b = st.bp_dia;
    const rest = `avg ${Math.round(a.average)}/${Math.round(b.average)} · latest ${g(a.last)}/${g(b.last)}`;
    bp = insSection("bp", "Blood pressure, mmHg", rest, a.days > 1 ? lineChart("bp", days, [{ val: d => d.bp_sys }, { val: d => d.bp_dia, cls: "soft" }], {
      rest, tip: d => `${g(d.bp_sys)}/${g(d.bp_dia)}${d.pulse != null ? ` · pulse ${g(d.pulse)}` : ""}`,
      label: `Blood pressure, ${dm(r.from)} to ${dm(r.to)}: ${rest}`,
    }) : "");
  }
  const out = one("weight", "Weight", st.weight_kg, "kg", d => d.weight_kg)
    + one("ketones", "Ketones, mmol/L", st.ketones_mmol, "", d => d.ketones_mmol)
    + one("glucose", `Glucose, ${gluUnitLabel(S.gluUnit)}`, st.glucose_mmol && mg
        ? Object.assign({}, st.glucose_mmol, { first: glu(st.glucose_mmol.first), last: glu(st.glucose_mmol.last), average: glu(st.glucose_mmol.average) })
        : st.glucose_mmol, "", d => d.glucose_mmol == null ? null : mg ? glu(d.glucose_mmol) : d.glucose_mmol)
    + one("gki", "GKI (glucose ÷ ketones)", st.gki, "", d => d.gki)
    + bp
    + one("pulse", "Pulse, bpm", st.pulse, "", d => d.pulse);
  return out || insSection("body", "Body", "", `<p class="empty">No measurements in this range. Add them from the Day tab.</p>`);
}

function renderInsWorkouts(r) {
  const w = r.summary.workouts;
  if (!w.sessions) return "";
  const top = w.kinds[0].sessions;
  const rows = w.kinds.map(x => `<li>
      <span class="it">${ut(x.name)}</span>
      <span class="num">${x.sessions}×${x.minutes ? ` · ${g(x.minutes)} min` : ""}</span>
      <span class="meter thin ink" aria-hidden="true"><i style="width:${x.sessions / top * 100}%"></i></span>
      <small class="num">last on ${dm(x.last_date)}</small></li>`).join("");
  return insSection("workouts", "Workouts", `${w.sessions} on ${w.days} of ${r.days.length} days${w.minutes ? ` · ${g(w.minutes)} min` : ""}`, `<ol class="tops">${rows}</ol>`);
}

function renderInsSymptoms(r) {
  const list = r.summary.symptoms;
  if (!list.length) return "";
  const top = list[0].days;
  const rows = list.map(x => `<li>
      <span class="it">${ut(x.name)}</span>
      <span class="num">${x.days} ${x.days === 1 ? "day" : "days"}</span>
      <span class="meter thin body" aria-hidden="true"><i style="width:${x.days / top * 100}%"></i></span>
      <small class="num">last on ${dm(x.last_date)}</small></li>`).join("");
  const days = r.days.filter(d => d.symptoms.length).length;
  return insSection("symptoms", "Symptoms", `on ${days} of ${r.days.length} days`, `<ol class="tops">${rows}</ol>`);
}

function renderInsFoods(r) {
  if (!r.foods.length || !(r.total_net_carbs_g > 0)) return "";
  const top = r.foods[0].net_carbs_g || 1;
  const rows = r.foods.filter(x => x.net_carbs_g > 0).map(x => `<li>
      <span class="it">${ut(x.item)}</span>
      <span class="num">${g(x.net_carbs_g)} g · ${x.share_pct}%</span>
      <span class="meter thin" aria-hidden="true"><i style="width:${x.net_carbs_g / top * 100}%"></i></span>
      <small class="num">logged ${x.times}×${x.calories != null ? ` · ${thousands(x.calories)} kcal` : ""}</small></li>`).join("");
  return insSection("foods", "Where the carbs come from", `${g(r.total_net_carbs_g)} g in total`, `<ol class="tops">${rows}</ol>`);
}

/* Scrub a chart: the header readout shows the day under the finger or pointer. */
function scrub(ev) {
  const plot = ev.target.closest ? ev.target.closest(".plotarea") : null;
  if (!plot) return;
  const c = CH[plot.dataset.chart], box = plot.getBoundingClientRect();
  if (!c || !box.width) return;
  const x = Math.min(Math.max((ev.clientX - box.left) / box.width, 0), 1);
  let i, at;
  if (c.line) {
    const want = x * (c.n - 1);
    i = c.idx.reduce((a, b) => Math.abs(b - want) < Math.abs(a - want) ? b : a, c.idx[0]);
    at = c.n > 1 ? i / (c.n - 1) * 100 : 50;
  } else {
    i = Math.min(c.n - 1, Math.floor(x * c.n));
    at = (i + .5) / c.n * 100;
  }
  const cur = plot.querySelector(".cursor");
  cur.hidden = false; cur.style.left = at + "%";
  const ro = document.getElementById("ro-" + plot.dataset.chart);
  if (ro) { ro.textContent = c.tip(i); ro.classList.add("on"); }
}
function scrubEnd(ev) {
  const plot = ev.target.closest ? ev.target.closest(".plotarea") : null;
  if (!plot || (ev.relatedTarget && plot.contains(ev.relatedTarget))) return;
  const c = CH[plot.dataset.chart], ro = document.getElementById("ro-" + plot.dataset.chart);
  plot.querySelector(".cursor").hidden = true;
  if (c && ro) { ro.textContent = c.rest || ""; ro.classList.remove("on"); }
}
document.addEventListener("pointerdown", scrub);
document.addEventListener("pointermove", scrub);
document.addEventListener("pointerout", ev => { if (ev.pointerType === "mouse") scrubEnd(ev); });

/* =========================================================================
   Assistant — food rows from words or a photo, the coach, the written review.
   The model only proposes; rows are saved by the user through /api/entries.
   ========================================================================= */
const BASIS = { history: "from your log", label: "from the label", estimate: "estimate" };
const blankAiFood = () => ({ text: "", busy: false, err: "", note: "", rows: null, from: "add", date: "", time: "", meal: "" });

function loadAi() {
  return api("/api/ai").then(a => {
    S.ai = a;
    if (!a.enabled && S.view === "coach") setView("day"); else { render(); if (S.view === "coach") loadChats(); }
  }).catch(() => {});
}

function renderAiBox() {
  const a = S.aiFood;
  if (!S.ai.enabled || S.ui.sheet !== "add") return "";
  return `
    <div class="ai-box">
      <label class="field">Describe it, in your own words<textarea name="ai_text" dir="auto" rows="2" placeholder="3 eggs fried in butter and half an avocado">${esc(a.text)}</textarea></label>
      <div class="row-btns">
        <button type="button" class="btn btn-primary" data-act="ai-fill" id="ai-fill"${a.busy ? " disabled" : ""}>${a.busy ? "Working…" : "Fill in"}</button>
        ${S.ai.vision ? `<label class="btn filebtn${a.busy ? " off" : ""}">Photo<input type="file" accept="image/*" data-file="ai-photo" class="sr"${a.busy ? " disabled" : ""}></label>` : ""}
        <span class="muted ai-by">${esc(S.ai.model)}</span>
      </div>
      <p class="error" id="ai-err" role="alert">${esc(a.err)}</p>
      ${a.note ? `<p class="hint" role="status" dir="auto">${esc(a.note)}</p>` : ""}
    </div>`;
}

// Downscale a photo in the browser: at most 1280 px on the long side, JPEG.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", .8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo could not be read.")); };
    img.src = url;
  });
}

// Leaving the review of a coach proposal without saving counts as declining it.
function declineReview() {
  const a = S.aiFood;
  if (S.ui.sheet === "ai" && a && a.from === "coach" && a.msg) markProposal(a.msg.chat, a.msg.id, "rows", "declined");
}

function openReview(rows, from) {
  const a = S.aiFood, time = hm(now());
  a.rows = rows.map(r => ({ on: true, item: r.item, quantity: r.quantity || "", basis: r.basis,
    net_carbs_g: str(r.net_carbs_g), calories: str(r.calories), fat_g: str(r.fat_g), protein_g: str(r.protein_g) }));
  a.from = from;
  a.date = from === "add" ? (S.form.date || S.date) : today();
  a.time = from === "add" && S.form.time ? S.form.time : time;
  a.meal = from === "add" ? S.form.meal : "";
  S.ui.sheet = "ai"; S.ui.error = ""; S.ui.busy = false;
  render();
}

function aiFill(image) {
  const a = S.aiFood;
  if (a.busy) return;
  if (!image && !a.text.trim()) { a.err = "Write what you ate first."; render(); return; }
  a.busy = true; a.err = ""; a.note = "";
  render();
  send("POST", "/api/ai/food", image ? { text: a.text, image } : { text: a.text }).then(res => {
    a.busy = false;
    if (!res.rows.length) { a.note = res.question || "Nothing to log was found. Try saying it another way."; render(); return; }
    a.note = res.dropped ? `${res.dropped} ${res.dropped === 1 ? "row" : "rows"} could not be read and were left out.` : "";
    if (S.ui.sheet === "add") openReview(res.rows, "add");
  }).catch(e => { a.busy = false; a.err = e.message; if (S.ui.sheet === "add") render(); });
}

function aiTotals() {
  const on = S.aiFood.rows.filter(r => r.on);
  const sum = k => on.reduce((t, r) => t + (num(r[k]) || 0), 0);
  return { n: on.length, net: sum("net_carbs_g"), kcal: sum("calories") };
}
function renderAiTotal() {
  const t = aiTotals(), a = S.aiFood;
  if (!t.n) return "Nothing selected.";
  const left = a.date === S.date && S.day ? ` · ${g(Math.abs(S.day.goal - (S.day.totals.net_carbs_g || 0) - t.net))} g ${S.day.goal - (S.day.totals.net_carbs_g || 0) - t.net < 0 ? "over" : "left"} after this` : "";
  return `Selected: ${g(t.net)} g net carbs · ${kcal(t.kcal)} kcal${left}`;
}
const aiSaveLabel = () => { const n = aiTotals().n; return n ? `Save ${n} ${n === 1 ? "row" : "rows"}` : "Save"; };

function renderAiReview() {
  const a = S.aiFood;
  const cell = (i, k, label, v, key) => `<label class="field${key ? " key" : ""}">${label}<input name="${k}_${i}" inputmode="decimal" value="${esc(v)}"></label>`;
  const rows = a.rows.map((r, i) => `<li class="${r.on ? "" : "off"}">
      <div class="ai-top">
        <input type="checkbox" name="on_${i}" aria-label="Save this row"${r.on ? " checked" : ""}>
        <input class="ai-item" name="item_${i}" dir="auto" aria-label="Item" value="${esc(r.item)}">
        <span class="tag ${r.basis}">${BASIS[r.basis]}</span>
      </div>
      <input class="ai-q" name="quantity_${i}" dir="auto" aria-label="Quantity" placeholder="Quantity" value="${esc(r.quantity)}">
      <div class="grid4">${cell(i, "net_carbs_g", "Net carbs", r.net_carbs_g, true)}${cell(i, "calories", "kcal", r.calories)}${cell(i, "fat_g", "Fat", r.fat_g)}${cell(i, "protein_g", "Protein", r.protein_g)}</div>
    </li>`).join("");
  const meals = S.meals.map(m => `<option value="${esc(m)}"></option>`).join("");
  return `
    <div class="sheet-h"><h2 id="sheet-title">Review before saving</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">&times;</button></div>
    <form class="form" data-form="ai-save" autocomplete="off" novalidate>
      <p class="muted hint">Filled in by ${esc(S.ai.model)}. Numbers marked “estimate” are a guess: check them before saving.</p>
      <ul class="ai-rows">${rows}</ul>
      <div class="grid2">
        <label class="field">Date<input type="date" name="date" value="${dmyToIso(a.date)}" max="${dmyToIso(today())}"></label>
        <label class="field">Time<input type="time" name="time" value="${esc(a.time)}"></label>
      </div>
      <label class="field">Meal<input name="meal" dir="auto" list="meals" value="${esc(a.meal)}"></label>
      <datalist id="meals">${meals}</datalist>
      <p class="preview num" id="ai-total">${renderAiTotal()}</p>
      <p class="error" id="form-error" role="alert">${esc(S.ui.error)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-act="ai-back">${a.from === "add" ? "Back" : "Cancel"}</button>
        <button class="btn btn-primary" id="ai-go"${S.ui.busy || !aiTotals().n ? " disabled" : ""}>${aiSaveLabel()}</button>
      </div>
    </form>`;
}

/* ---------- coach ----------
   Chats live on the server, so every device sees the same list. */
const COACH_STARTERS = ["What can I still eat today?", "How was my week?", "Dinner ideas under 8 g net carbs", "Where do my carbs come from?"];
// "14:05" today, otherwise "05/10 14:05".
const stamp = iso => { const d = new Date(iso); return isNaN(d) ? "" : dmy(d) === today() ? hm(d) : `${dmy(d).slice(0, 5)} ${hm(d)}`; };

function loadChats() {
  const c = S.coach;
  api("/api/chats").then(list => { c.list = list; if (S.view === "coach" && !c.chat && !c.busy) paintCoach(); }).catch(() => {});
}
function openChat(id) {
  const c = S.coach, seq = ++c.seq;
  c.err = "";
  api(`/api/chats/${id}`).then(chat => {
    if (seq !== c.seq) return;
    c.chat = chat; c.busy = false;
    if (S.view === "coach") paintCoach();
  }).catch(e => { if (seq === c.seq) { c.chat = null; c.err = e.message; loadChats(); if (S.view === "coach") paintCoach(); } });
}
function closeChat() {
  const c = S.coach;
  c.seq++; c.chat = null; c.busy = false; c.err = ""; c.retry = false;
  loadChats();
  paintCoach(true);
}

function renderCoach() {
  const c = S.coach, chat = c.chat;
  const msgs = (chat ? chat.messages : []).map((m, i) => `<div class="msg ${m.role === "user" ? "me" : "bot"}">
      <p dir="auto">${esc(m.content)}</p>
      ${m.rows && m.rows.length ? `<ul class="msg-rows num">${m.rows.map(r => `<li><span class="it">${ut(r.item)}${r.quantity ? ` <small>${ut(r.quantity)}</small>` : ""}</span><span>${g(r.net_carbs_g)} g</span></li>`).join("")}</ul>
      ${proposalState(m.rows_status, i, "rows", "Review and add")}` : ""}
      ${m.notes && m.notes.length ? `<ul class="msg-rows">${m.notes.map(n => `<li><span class="it">${noteTags(n)}${n.notes ? `<small dir="auto"> ${esc(n.notes)}</small>` : ""}</span><span class="num">${n.date === today() ? "" : dm(n.date) + " "}${n.time || ""}</span></li>`).join("")}</ul>
      ${proposalState(m.notes_status, i, "notes", m.notes.length === 1 ? "Add to log" : `Add ${m.notes.length} to log`)}` : ""}
      <time class="msg-at num" datetime="${esc(m.at)}">${stamp(m.at)}</time>
    </div>`).join("");
  const head = chat
    ? `<header class="ins-h"><h1 class="chat-title">${ut(chat.title)}</h1><span class="chat-links"><button type="button" class="link" data-act="coach-close">Chats</button>${chat.id ? `<button type="button" class="link" data-act="coach-delete">Delete</button>` : ""}</span></header>`
    : `<header class="ins-h"><h1>Coach</h1></header>
       <p class="ins-sub">Sees your log from the last 14 days. Answers come from ${esc(S.ai.model || "the model")} and are not medical advice. Chats are saved and shared between your devices.</p>`;
  const starters = chat ? "" : `<div class="starters">${COACH_STARTERS.map((s, i) => `<button type="button" class="chip" data-act="coach-ask" data-i="${i}">${s}</button>`).join("")}</div>`;
  const list = chat || !c.list.length ? "" : `
    <div class="sec-h"><h2>Latest chats</h2></div>
    <ul class="chats">${c.list.map(x => `<li><button type="button" data-act="coach-open" data-id="${x.id}">
      <span class="it">${ut(x.title)}</span>
      <small class="num">${stamp(x.updated_at)} · ${x.messages} ${x.messages === 1 ? "message" : "messages"}</small></button></li>`).join("")}</ul>`;
  return `
    ${head}
    ${starters}
    ${chat ? `<div class="thread" id="thread" aria-live="polite">${msgs}${c.busy ? `<div class="msg bot wait"><p>Thinking…</p></div>` : ""}</div>` : ""}
    ${c.err ? `<p class="error" role="alert">${esc(c.err)}${c.retry ? ` <button type="button" class="link" data-act="coach-retry">Try again</button>` : ""}</p>` : ""}
    ${list}
    <form class="coach-bar" data-form="coach" novalidate><div class="pinbar-in">
      <textarea name="q" dir="auto" rows="1" enterkeyhint="send" aria-label="Message" placeholder="${chat ? "Ask, or say what to log" : "Start a new chat"}">${esc(c.draft)}</textarea>
      <button class="btn btn-primary"${c.busy ? " disabled" : ""}>Send</button></div></form>`;
}

// What became of a proposal: buttons while undecided, then a lasting line.
function proposalState(status, i, kind, label) {
  if (status === "added") return `<p class="outcome added">Added to your log</p>`;
  if (status === "declined") return `<p class="outcome declined">Not added <button type="button" class="link" data-act="coach-undecide" data-kind="${kind}" data-i="${i}">Reconsider</button></p>`;
  return `<div class="row-btns"><button type="button" class="btn btn-primary" data-act="coach-${kind === "rows" ? "review" : "add-notes"}" data-i="${i}">${label}</button>
    <button type="button" class="btn" data-act="coach-decline" data-kind="${kind}" data-i="${i}">Dismiss</button></div>`;
}
// Record the outcome on the saved message, so every device shows it.
function markProposal(chatId, msgId, kind, status) {
  return send("PATCH", `/api/chats/${chatId}/messages/${msgId}`, { [kind + "_status"]: status }).then(res => {
    const c = S.coach;
    if (c.chat && c.chat.id === chatId && !c.busy) { c.chat = res.chat; if (S.view === "coach") paintCoach(false, true); }
  }).catch(fail);
}
function addCoachNotes(m) {
  const chatId = S.coach.chat.id;
  Promise.all(m.notes.map(n => send("POST", "/api/notes", notePayload(n)))).then(res => {
    const ids = res.map(r => r.note.id);
    toast(`Added ${m.notes.map(noteText).join("; ")}`, () => Promise.all(ids.map(id => api(`/api/notes/${id}`, { method: "DELETE" })))
      .then(() => markProposal(chatId, m.id, "notes", null)));
    return markProposal(chatId, m.id, "notes", "added");
  }).catch(fail);
}

function paintCoach(focus, keepScroll) {
  const y = window.scrollY;
  paint("coach", renderCoach());
  if (keepScroll) window.scrollTo(0, y);
  else if (S.coach.chat) window.scrollTo(0, document.documentElement.scrollHeight); else window.scrollTo(0, 0);
  if (focus) { const t = document.querySelector("#coach [name=q]"); if (t) t.focus(); }
}

// text: a new message; null: ask again for an answer to the last saved message.
function coachSend(text) {
  const c = S.coach;
  if (c.busy) return;
  let body;
  if (text == null) body = { chat_id: c.chat.id, retry: true };
  else {
    text = text.trim();
    if (!text) return;
    body = { chat_id: c.chat ? c.chat.id : null, message: text };
    // Shown at once; the saved chat replaces it when the answer arrives.
    if (!c.chat) c.chat = { id: null, title: text, messages: [] };
    c.chat.messages.push({ role: "user", content: text, rows: [], at: new Date().toISOString(), unsent: true });
    c.draft = "";
  }
  c.busy = true; c.err = ""; c.retry = false;
  paintCoach();
  const seq = ++c.seq;
  send("POST", "/api/ai/chat", body).then(res => {
    if (seq !== c.seq) return;
    c.busy = false; c.chat = res.chat;
    if (S.view === "coach") paintCoach();
  }).catch(e => {
    if (seq !== c.seq) return;
    c.busy = false; c.err = e.message;
    if (e.body && e.body.chat) { c.chat = e.body.chat; c.retry = true; }      // the message is saved; only the answer failed
    else if (text != null) {                                                 // nothing was saved: hand the text back
      c.chat.messages = c.chat.messages.filter(m => !m.unsent);
      if (!c.chat.id) c.chat = null;
      c.draft = text;
    }
    if (S.view === "coach") paintCoach();
  });
}

/* ---------- written review on Insights ---------- */
function renderInsReview(r) {
  if (!S.ai.enabled || !r.summary.logged_days) return "";
  const v = S.ins.review;
  const mine = v && v.range === S.ins.range ? v : null;
  const body = !mine ? `<p class="muted">A short written review of this range, from the numbers on this page.</p>`
    : mine.busy ? `<p class="muted">Writing…</p>`
    : mine.err ? `<p class="error" role="alert">${esc(mine.err)}</p>`
    : `<p class="review" dir="auto">${esc(mine.text)}</p><p class="muted hint num">${esc(mine.model || "")} · ${esc(mine.generated_at)}</p>`;
  return `
    <section class="ins-sec" data-ins="review">
      <div class="sec-h"><h2>Written review</h2><button type="button" class="link" data-act="ins-review"${mine && mine.busy ? " disabled" : ""}>${mine && mine.text ? "Write again" : "Write it"}</button></div>
      ${body}
    </section>`;
}
function insReview() {
  const range = S.ins.range, again = !!(S.ins.review && S.ins.review.range === range && S.ins.review.text);
  S.ins.review = { range, busy: true };
  paint("insights", renderInsights());
  send("POST", "/api/ai/summary", { days: range, refresh: again })
    .then(res => { if (S.ins.review.range === range) S.ins.review = Object.assign({ range }, res); })
    .catch(e => { if (S.ins.review.range === range) S.ins.review = { range, err: e.message }; })
    .then(() => { if (S.view === "insights") paint("insights", renderInsights()); });
}

/* =========================================================================
   Actions
   ========================================================================= */
let toastTimer;
// msg: a string, or a list of strings and {u: text} parts (user text, direction isolated).
function toast(msg, undo, action, err) {
  S.ui.toast = { msg, undo, action, err };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.ui.toast = null; paint("toast", ""); }, undo || action ? 8000 : 5000);
  paint("toast", renderToast());
}
const fail = e => toast(e.message, null, null, true);

/* Day change: the old day dims while loading, the new one slides in from the
   side it came from (next day from the right). */
const SLIDE_PARTS = ["#nav h1", "#glance", "#quick", "#log", "#more"];
function slideIn() {
  const dir = S.ui.slide;
  S.ui.slide = 0;
  document.querySelector(".app").classList.remove("switching");
  if (!dir || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const anims = [];
  SLIDE_PARTS.forEach((sel, i) => {
    const el = document.querySelector(sel);
    if (el && el.animate) anims.push(el.animate(
      [{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: "none" }],
      { duration: 260, delay: i * 30, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }));
  });
  // If the animation clock stalls (paused tab, some webviews), never leave the day hidden.
  setTimeout(() => anims.forEach(a => { if (a.playState !== "finished") a.finish(); }), 600);
}

// Days run from the first tracked day to today; nothing before or after.
function clampDay(date) {
  if (after(date, today())) return today();
  if (S.first && after(S.first, date)) return S.first;
  return date;
}

function goTo(date) {
  date = clampDay(date);
  if (date !== S.date) S.ui.slide = dmyToIso(date) > dmyToIso(S.date) ? 1 : -1;
  document.querySelector(".app").classList.toggle("switching", !!S.ui.slide);
  S.date = date;
  S.ui.expanded = null; S.ui.goalEdit = false; S.ui.fastEditId = null; S.ui.fastAdjust = false;
  load();
}

function setBaseFrom(x) {
  const grams = gramsIn(x.quantity);
  S.form.base = { grams, weight: grams || 1, quantity: x.quantity || "",
    vals: { net_carbs_g: x.net_carbs_g, calories: x.calories, fat_g: x.fat_g, protein_g: x.protein_g } };
  S.form.weight = tidy(grams || 1);
}
function pickItem(x) {
  Object.assign(S.form, { item: x.item, quantity: x.quantity || "", suggest: false });
  for (const k of MACROS) S.form[k] = str(x[k]);
  setBaseFrom(x);
  S.sugg = [];
}
// Scale from the base; `typed` keeps the weight field as the user typed it.
function setWeight(w, typed) {
  const b = S.form.base;
  if (!b || !(w > 0)) return;
  const r = w / b.weight;
  if (!typed) S.form.weight = tidy(w);
  if (b.quantity) S.form.quantity = b.quantity.replace(NUM_RE, m => tidy(num(m) * r));
  for (const k of MACROS) S.form[k] = b.vals[k] == null ? "" : tidy(b.vals[k] * r);
}
function startEdit(id) {
  const x = entryById(id);
  if (!x) return;
  S.ui.sheet = "edit"; S.ui.editingId = id; S.ui.error = ""; S.ui.open.form = true;
  S.form = blankForm({ item: x.item, quantity: x.quantity || "", date: x.date, time: x.time || "",
    meal: x.meal || "", notes: x.notes || "", fasting_hours: str(x.fasting_hours) });
  for (const k of MACROS) S.form[k] = str(x[k]);
  setBaseFrom(x);
  S.sugg = [];
}
function openAdd() {
  S.ui.sheet = "add"; S.ui.editingId = null; S.ui.error = "";
  S.form = blankForm();
  S.aiFood = blankAiFood();
  if (S.pendingFastHours != null) {
    S.form.fasting_hours = g(S.pendingFastHours);
    S.ui.open.form = true;
  }
  S.sugg = [];
}
function closeSheet() {
  S.ui.sheet = null; S.ui.editingId = null; S.ui.error = ""; S.ui.busy = false;
}

// One-tap logging at the current time (chips and "Log again now").
function logNow(src) {
  const time = hm(now());
  const entry = { date: S.date, time, item: src.item, quantity: src.quantity || null, calories: src.calories,
    fat_g: src.fat_g, protein_g: src.protein_g, net_carbs_g: src.net_carbs_g, meal: guessMeal(time) };
  send("POST", "/api/entries", entry).then(res => {
    const id = res.created[0].id;
    toast(["Added ", { u: src.item }, ` · ${g(src.net_carbs_g)} g`], () => api(`/api/entries/${id}`, { method: "DELETE" }));
    loadLists();
    return load();
  }).catch(fail);
}

function deleteEntry(id) {
  const x = entryById(id);
  if (!x) return;
  api(`/api/entries/${id}`, { method: "DELETE" }).then(res => {
    if (S.ui.expanded === id) S.ui.expanded = null;
    toast(["Deleted ", { u: x.item }], () => send("POST", "/api/entries/restore", res.deleted));
    loadLists();
    return load();
  }).catch(fail);
}

function startFast(at) {
  send("POST", "/api/fasts/start", at || {}).then(res => {
    const f = res.fast;
    S.ui.fastAdjust = false;
    toast(`Fast started · ${fmtAt(f.start_date, f.start_time)}`,
      () => api(`/api/fasts/${f.id}`, { method: "DELETE" }),
      { label: "Adjust", run: () => openFastAdjust() });
    return load();
  }).catch(fail);
}
function openFastAdjust() {
  const away = S.date !== today();
  if (away) goTo(today());
  S.ui.fastAdjust = true; S.ui.fastError = "";
  if (!away) { render(); focusFastAdjust(); }
}
function focusFastAdjust() {
  const el = document.querySelector(".fast-adjust [name=start]");
  if (el) el.focus();
}
// Shift a datetime-local value by whole minutes (wall-clock arithmetic).
function shiftLocal(v, mins) {
  const d = new Date(v + ":00Z");
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16);
}
function stopFast(at) {
  send("POST", "/api/fasts/stop", at || {}).then(res => {
    const f = res.fast, h = f.hours;
    S.pendingFastHours = h;
    toast(`Fast ended · ${g(h)} h`,
      () => send("PATCH", `/api/fasts/${f.id}`, { end_date: null, end_time: null }).then(() => { S.pendingFastHours = null; }),
      { label: "Log meal", run: () => { openAdd(); render(); focusItem(); } });
    return load();
  }).catch(fail);
}

/* ---------- measurements ---------- */
const MEASURE_KEYS = ["weight_kg", "ketones_mmol", "glucose_mmol", "bp_sys", "bp_dia", "pulse"];
function openMeasure(m) {
  S.measure = m ? { ...m } : { id: null, date: S.date, time: S.date === today() ? hm(now()) : "", notes: "" };
  S.ui.sheet = "measure"; S.ui.error = ""; S.ui.busy = false;
  render();
  const el = document.querySelector("#sheet [name=bp_sys]"); if (el && !m) el.focus();
}
function measurePayload(m) {
  const out = { date: m.date, time: m.time || null, notes: m.notes || null };
  for (const k of MEASURE_KEYS) out[k] = m[k] ?? null;
  return out;
}
function deleteMeasure(id) {
  api(`/api/measurements/${id}`, { method: "DELETE" }).then(res => {
    toast(`Deleted measurement${res.deleted.time ? ` at ${res.deleted.time}` : ""}`,
      () => send("POST", "/api/measurements", measurePayload(res.deleted)));
    return load();
  }).catch(fail);
}

/* ---------- import from the sheet ---------- */
let importTimer, importSeq = 0;
function openImport() {
  S.imp = { text: "", res: null, err: "", busy: false };
  S.ui.sheet = "import";
  render();
  const el = document.querySelector("#sheet [name=text]"); if (el) el.focus();
}
function refreshImport() {
  const p = document.getElementById("imp-preview"); if (p) p.innerHTML = renderImportPreview();
  const b = document.getElementById("imp-go"); if (b) { b.disabled = !importReady(); b.textContent = importLabel(); }
}
// Dry run as the user pastes or types: what would be added, skipped or rejected.
function previewImport() {
  clearTimeout(importTimer);
  const text = S.imp.text, seq = ++importSeq;
  if (!text.trim()) { S.imp.res = null; S.imp.err = ""; refreshImport(); return; }
  importTimer = setTimeout(() => {
    send("POST", "/api/import", { text, dry_run: true })
      .then(res => { if (seq === importSeq) { S.imp.res = res; S.imp.err = ""; refreshImport(); } })
      .catch(e => { if (seq === importSeq) { S.imp.res = null; S.imp.err = e.message; refreshImport(); } });
  }, 300);
}

function calcNet() {
  const val = n => parseFloat(String(document.querySelector(`[name=${n}]`)?.value || "").replace(",", ".")) || 0;
  const total = num(document.querySelector("[name=calc_total]")?.value || "");
  return isNaN(total) ? null : Math.max(0, Math.round((total - val("calc_fiber") - val("calc_sa")) * 10) / 10);
}

function focusItem() {
  const el = document.querySelector("#sheet [name=item]");
  if (el) el.focus();
}

// Repaint the parts of the sheet that depend on typed values, keeping focus.
function refreshSheetBits() {
  const p = document.getElementById("preview"); if (p) p.innerHTML = renderPreview(day());
  const m = document.getElementById("more-sum"); if (m) m.innerHTML = renderMoreSummary();
}

document.addEventListener("click", ev => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act, id = +el.dataset.id, d = day();
  switch (act) {
    case "view": if (el.dataset.view !== S.view) setView(el.dataset.view); return;
    case "note-add": openNote(null, "feel"); return;
    case "workout-add": openNote(null, "workout"); return;
    case "note-kind": {
      const n = S.note, name = el.dataset.name, on = !(n.workout && sameName(n.workout, name));
      n.workout = on ? name : ""; n.kind = "";
      el.form.elements.kind.value = "";
      el.form.querySelectorAll("[data-act=note-kind]").forEach(b => b.setAttribute("aria-pressed", String(on && b === el)));
      if (on && !n.minutes) el.form.elements.minutes.focus();
      return;
    }
    case "note-edit": { const n = (d.notes || []).find(x => x.id === id); if (n) openNote(n); return; }
    case "note-delete": deleteNote(id); return;
    case "note-sym": {
      const n = S.note, name = el.dataset.name, i = n.symptoms.findIndex(x => sameName(x, name));
      if (i >= 0) n.symptoms.splice(i, 1); else n.symptoms.push(name);
      el.setAttribute("aria-pressed", String(i < 0));
      return;
    }
    case "ai-fill": aiFill(); return;
    case "ai-back":
      if (S.aiFood.from === "add") { S.ui.sheet = "add"; S.ui.error = ""; S.ui.busy = false; } else { declineReview(); closeSheet(); }
      break;
    case "coach-ask": coachSend(COACH_STARTERS[+el.dataset.i]); return;
    case "coach-retry": coachSend(null); return;
    case "coach-close": closeChat(); return;
    case "coach-open": openChat(id); return;
    case "coach-delete": {
      const chat = S.coach.chat;
      if (!chat || !chat.id || !window.confirm("Delete this chat on all devices?")) return;
      api(`/api/chats/${chat.id}`, { method: "DELETE" }).then(closeChat).catch(fail);
      return;
    }
    case "coach-review": {
      const m = S.coach.chat && S.coach.chat.messages[+el.dataset.i];
      if (m && m.rows.length) { S.aiFood = blankAiFood(); S.aiFood.msg = { chat: S.coach.chat.id, id: m.id }; openReview(m.rows, "coach"); }
      return;
    }
    case "coach-add-notes": { const m = S.coach.chat && S.coach.chat.messages[+el.dataset.i]; if (m && m.notes.length) { el.disabled = true; addCoachNotes(m); } return; }
    case "coach-decline": case "coach-undecide": {
      const m = S.coach.chat && S.coach.chat.messages[+el.dataset.i];
      if (m) markProposal(S.coach.chat.id, m.id, el.dataset.kind, act === "coach-decline" ? "declined" : null);
      return;
    }
    case "ins-review": insReview(); return;
    case "ins-range":
      S.ins.range = el.dataset.range; saveRange(S.ins.range);
      paint("insights", renderInsights());
      loadInsights();
      return;
    case "day": goTo(addDays(S.date, +el.dataset.n)); return;
    case "today": goTo(today()); return;
    case "goto": goTo(el.dataset.date); return;
    case "goal-edit": S.ui.goalEdit = true; S.ui.goalError = ""; break;
    case "goal-cancel": S.ui.goalEdit = false; break;
    case "goal-inherit":
      send("POST", "/api/goal", { date: S.date, net_carbs_goal: null })
        .then(() => { S.ui.goalEdit = false; return load(); }).catch(fail);
      return;
    case "expand": S.ui.expanded = S.ui.expanded === id ? null : id; break;
    case "edit": startEdit(id); render(); focusItem(); return;
    case "delete": deleteEntry(id); return;
    case "log-again": { const x = entryById(id); if (x) logNow(x); return; }
    case "quick": { const x = S.top[+el.dataset.i]; if (x) logNow(x); return; }
    case "open-add": openAdd(); render(); focusItem(); return;
    case "close-sheet": declineReview(); closeSheet(); break;
    case "pick": {
      const x = S.sugg[+el.dataset.i];
      if (!x) return;
      pickItem(x); render();
      const w = document.querySelector("#sheet [name=weight]"); if (w) { w.focus(); w.select(); }
      return;
    }
    case "portion": setWeight(S.form.base.weight * +el.dataset.p); break;
    case "calc-use": { const out = calcNet(); if (out != null) S.form.net_carbs_g = tidy(out); break; }
    case "copy-open": S.ui.sheet = "copy"; S.ui.error = ""; S.ui.copyIds = d.entries.map(x => x.id); S.ui.copyTarget = null; break;
    case "copy-some": S.ui.sheet = "copy"; S.ui.error = ""; S.ui.copyIds = el.dataset.ids.split(",").map(Number); S.ui.copyTarget = null; break;
    case "fast-start": startFast(); return;
    case "fast-stop": stopFast(); return;
    case "fast-adjust": openFastAdjust(); return;
    case "measure-add": openMeasure(); return;
    case "glu-unit": {
      // Switch the unit, converting what is typed; the rest of the sheet keeps its input.
      const u = el.dataset.u, input = el.form.elements.glucose_mmol, v = numOrNull(input.value);
      if (u === S.gluUnit) return;
      if (v != null && !isNaN(v)) input.value = gluShow(gluToMmol(v, S.gluUnit), u);
      S.gluUnit = u; saveGluUnit(u);
      document.getElementById("glu-unit").textContent = gluUnitLabel(u);
      el.form.querySelectorAll("[data-act=glu-unit]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.u === u)));
      paint("more", renderWeek() + renderFasting(d) + renderBody(d) + renderNotes(d));
      return;
    }
    case "measure-edit": { const m = (d.body?.measurements || []).find(x => x.id === id); if (m) openMeasure(m); return; }
    case "measure-delete": deleteMeasure(id); return;
    case "import-open": openImport(); return;
    case "fast-adjust-cancel": S.ui.fastAdjust = false; S.ui.fastError = ""; break;
    case "fast-shift": {
      const input = el.form.elements.start;
      if (input.value) input.value = shiftLocal(input.value, +el.dataset.m);
      return;
    }
    case "fast-edit": S.ui.fastEditId = S.ui.fastEditId === id ? null : id; S.ui.fastError = ""; break;
    case "fast-delete": {
      const f = d.active_fast && d.active_fast.id === id ? d.active_fast : d.fasts.find(x => x.id === id);
      const what = f && !f.end_date ? "the running fast" : `this ${g(f ? f.hours : 0)} h fast`;
      if (!window.confirm(`Delete ${what}?`)) return;
      api(`/api/fasts/${id}`, { method: "DELETE" }).then(() => load()).catch(fail);
      return;
    }
    case "water":
      S.ui.bodyError = "";
      send("POST", "/api/body", { date: S.date, add_water_ml: +el.dataset.ml }).then(() => load())
        .catch(e => { S.ui.bodyError = e.message; render(); });
      return;
    case "undo": {
      const undo = S.ui.toast && S.ui.toast.undo;
      S.ui.toast = null; paint("toast", "");
      if (undo) Promise.resolve(undo()).then(() => { loadLists(); return load(); }).catch(fail);
      return;
    }
    case "toast-action": { const a = S.ui.toast.action; S.ui.toast = null; paint("toast", ""); a.run(); return; }
    default: return;
  }
  render();
});

/* Typing: update state and the few dependent bits without re-rendering the sheet (keeps focus). */
document.addEventListener("input", ev => {
  const t = ev.target, form = t.form && t.form.dataset.form;
  if (form === "copy" && t.name === "ids") {
    S.ui.copyIds = [...t.form.querySelectorAll("[name=ids]:checked")].map(x => +x.value);
    document.getElementById("copy-go").textContent = copyLabel();
    return;
  }
  if (form === "import") { S.imp.text = t.value; previewImport(); return; }
  if (t.name === "ai_text") { S.aiFood.text = t.value; return; }
  if (form === "note") {
    if (t.name === "date") S.note.date = t.value ? isoToDmy(t.value) : S.note.date; else if (t.name in S.note) S.note[t.name] = t.value;
    return;
  }
  if (form === "coach") { S.coach.draft = t.value; return; }
  if (form === "ai-save") {
    const a = S.aiFood, m = /^(on|item|quantity|net_carbs_g|calories|fat_g|protein_g)_(\d+)$/.exec(t.name);
    if (m) {
      a.rows[+m[2]][m[1]] = m[1] === "on" ? t.checked : t.value;
      if (m[1] === "on") t.closest("li").classList.toggle("off", !t.checked);
    } else if (t.name === "date") a.date = t.value ? isoToDmy(t.value) : a.date;
    else if (t.name === "time" || t.name === "meal") a[t.name] = t.value;
    document.getElementById("ai-total").innerHTML = renderAiTotal();
    const go = document.getElementById("ai-go"); go.textContent = aiSaveLabel(); go.disabled = !aiTotals().n;
    return;
  }
  if (form !== "entry") return;
  const f = S.form;
  if (t.name === "item") {
    f.item = t.value;
    if (!t.value.trim()) f.base = null;
    updateSuggestions();
    f.suggest = S.sugg.length > 0;
    const ul = document.getElementById("sugg"); ul.innerHTML = renderSuggestions(); ul.hidden = !f.suggest;
    t.setAttribute("aria-expanded", String(f.suggest));
    return;
  }
  if (t.name === "weight" && f.base) {
    f.weight = t.value;
    setWeight(num(t.value), true);
    for (const k of ["quantity", ...MACROS]) t.form.elements[k].value = f[k];
    t.form.querySelectorAll("[data-act=portion]").forEach(b =>
      b.setAttribute("aria-pressed", String(num(f.weight) === +tidy(f.base.weight * +b.dataset.p))));
  } else if (t.name.startsWith("calc_")) {
    const out = calcNet(); document.getElementById("calc-out").textContent = out == null ? "= – g" : `= ${g(out)} g`; return;
  } else if (t.name === "date") f.date = t.value ? isoToDmy(t.value) : "";
  else if (t.name in f) f[t.name] = t.value;
  refreshSheetBits();
});

document.addEventListener("change", ev => {
  if (ev.target.dataset.file === "ai-photo") {
    const file = ev.target.files && ev.target.files[0];
    if (file) shrinkImage(file).then(aiFill).catch(e => { S.aiFood.err = e.message; render(); });
    return;
  }
  if (ev.target.dataset.actChange === "target") {
    S.fastTarget = +ev.target.value; saveTarget(S.fastTarget);
    paint("glance", renderGlance(day()));
    const sum = document.querySelector("[data-sec=fast] .sum");
    if (sum && day().active_fast) sum.textContent = `${dur(fastHours(day().active_fast))} · ${targetText(day().active_fast)}`;
  }
});
document.addEventListener("toggle", ev => {
  const sec = ev.target.dataset && ev.target.dataset.sec; if (sec) S.ui.open[sec] = ev.target.open;
}, true);

document.addEventListener("submit", ev => {
  ev.preventDefault();
  const fm = ev.target, kind = fm.dataset.form, data = new FormData(fm);

  if (kind === "goal") {
    const v = numOrNull(data.get("goal"));
    if (v == null || !(v > 0)) { S.ui.goalError = "Goal must be a number above 0."; render(); return; }
    send("POST", "/api/goal", { date: S.date, net_carbs_goal: v })
      .then(() => { S.ui.goalEdit = false; return load(); })
      .catch(e => { S.ui.goalError = e.message; render(); });
    return;
  }
  if (kind === "fast-toggle") {
    const at = fromLocal(data.get("at"));
    const body = at.date ? { date: at.date, time: at.time } : {};
    if (day().active_fast) stopFast(body); else startFast(body);
    return;
  }
  if (kind === "fast-start-time") {
    const s = fromLocal(data.get("start"));
    if (!s.date) { S.ui.fastError = "Pick a start time."; render(); return; }
    S.ui.fastError = "";
    send("PATCH", `/api/fasts/${+fm.dataset.id}`, { start_date: s.date, start_time: s.time })
      .then(() => { S.ui.fastAdjust = false; toast(`Fast start moved to ${fmtAt(s.date, s.time)}`); return load(); })
      .catch(err => { S.ui.fastError = err.message; render(); focusFastAdjust(); });
    return;
  }
  if (kind === "fast") {
    const s = fromLocal(data.get("start")), e = fromLocal(data.get("end"));
    S.ui.fastError = "";
    send("PATCH", `/api/fasts/${+fm.dataset.id}`, { start_date: s.date, start_time: s.time, end_date: e.date, end_time: e.time,
      notes: String(data.get("notes") || "").trim() ? data.get("notes") : null })
      .then(() => { S.ui.fastEditId = null; return load(); })
      .catch(err => { S.ui.fastError = err.message; render(); });
    return;
  }
  if (kind === "measure") {
    const m = { id: S.measure.id, date: data.get("date") ? isoToDmy(data.get("date")) : S.date,
      time: data.get("time") || null, notes: String(data.get("notes") || "").trim() || null };
    for (const k of MEASURE_KEYS) m[k] = numOrNull(data.get(k));
    const [lo, hi] = S.gluUnit === "mgdl" ? [9, 720] : [0.5, 40];
    if (m.glucose_mmol != null && !isNaN(m.glucose_mmol) && !(m.glucose_mmol >= lo && m.glucose_mmol <= hi)) {
      S.ui.error = `Glucose must be between ${lo} and ${hi} ${gluUnitLabel(S.gluUnit)}.`;
      document.getElementById("form-error").textContent = S.ui.error; fm.elements.glucose_mmol.focus(); return;
    }
    if (m.glucose_mmol != null && !isNaN(m.glucose_mmol)) m.glucose_mmol = gluToMmol(m.glucose_mmol);
    const err = (el, msg) => { S.ui.error = msg; document.getElementById("form-error").textContent = msg; if (el) fm.elements[el].focus(); };
    const bad = MEASURE_KEYS.find(k => m[k] != null && isNaN(m[k]));
    if (bad) return err(bad, "Numbers only.");
    if ((m.bp_sys == null) !== (m.bp_dia == null)) return err(m.bp_sys == null ? "bp_sys" : "bp_dia", "Blood pressure needs both numbers.");
    if (MEASURE_KEYS.every(k => m[k] == null)) return err("bp_sys", "Enter at least one value.");
    S.ui.error = ""; S.ui.busy = true;
    const editing = m.id != null, payload = measurePayload(m);
    (editing ? send("PATCH", `/api/measurements/${m.id}`, payload) : send("POST", "/api/measurements", payload)).then(res => {
      const saved = res.measurement;
      closeSheet(); S.ui.open.body = true;
      toast(`${editing ? "Saved" : "Added"} ${measureText(saved)}${saved.date !== S.date ? ` to ${saved.date.slice(0, 5)}` : ""}`,
        editing ? null : () => api(`/api/measurements/${saved.id}`, { method: "DELETE" }));
      if (saved.date !== S.date) goTo(saved.date); else load();
    }).catch(e => { S.ui.busy = false; S.ui.error = e.message; render(); });
    return;
  }
  if (kind === "note") {
    const n = S.note, symptoms = n.symptoms.slice();
    for (const x of n.other.split(",").map(x => x.trim()).filter(Boolean)) if (!symptoms.some(y => sameName(x, y))) symptoms.push(x);
    const fails = msg => { S.ui.error = msg; document.getElementById("form-error").textContent = msg; };
    const workout = n.kind.trim() || n.workout || null, minutes = numOrNull(n.minutes);
    if (n.mode === "workout" && !workout) return fails("Pick the kind of workout.");
    if (minutes != null && (isNaN(minutes) || !(minutes > 0))) return fails("Minutes must be a number above 0.");
    if (!symptoms.length && !n.notes.trim() && !workout) return fails("Pick a symptom or write a note.");
    const payload = { date: n.date, time: n.time || null, symptoms, notes: n.notes.trim() ? n.notes : null,
      workout, minutes: workout ? minutes : null }, editing = n.id != null;
    S.ui.error = ""; S.ui.busy = true;
    (editing ? send("PATCH", `/api/notes/${n.id}`, payload) : send("POST", "/api/notes", payload)).then(res => {
      const saved = res.note;
      closeSheet(); S.ui.open.notes = true;
      toast([editing ? "Saved " : "Added ", { u: noteText(saved) }, saved.date !== S.date ? ` to ${saved.date.slice(0, 5)}` : ""],
        editing ? null : () => api(`/api/notes/${saved.id}`, { method: "DELETE" }));
      if (saved.date !== S.date) goTo(saved.date); else load();
    }).catch(e => { S.ui.busy = false; S.ui.error = e.message; render(); });
    return;
  }
  if (kind === "coach") { coachSend(String(data.get("q") || "")); return; }
  if (kind === "ai-save") {
    const a = S.aiFood, rows = a.rows.filter(r => r.on);
    const fails = msg => { S.ui.error = msg; document.getElementById("form-error").textContent = msg; };
    const entries = rows.map(r => ({ date: a.date, time: a.time || null, item: r.item, quantity: r.quantity.trim() ? r.quantity : null,
      net_carbs_g: numOrNull(r.net_carbs_g), calories: numOrNull(r.calories), fat_g: numOrNull(r.fat_g), protein_g: numOrNull(r.protein_g),
      meal: a.meal.trim() ? a.meal : null }));
    if (!entries.length) return fails("Nothing selected.");
    if (entries.some(e => !e.item.trim())) return fails("Every row needs an item name.");
    if (entries.some(e => e.net_carbs_g == null || MACROS.some(k => e[k] != null && isNaN(e[k])))) return fails("Every row needs net carbs, and numbers only.");
    S.ui.error = ""; S.ui.busy = true; document.getElementById("ai-go").disabled = true;
    const from = a.from, msg = a.msg;
    send("POST", "/api/entries", entries).then(res => {
      const ids = res.created.map(x => x.id), net = entries.reduce((t, e) => t + e.net_carbs_g, 0);
      closeSheet(); loadLists();
      S.aiFood = blankAiFood();
      if (msg) markProposal(msg.chat, msg.id, "rows", "added");
      toast(`Added ${ids.length} ${ids.length === 1 ? "row" : "rows"} · ${g(net)} g${a.date !== S.date || from !== "add" ? ` to ${a.date.slice(0, 5)}` : ""}`,
        () => Promise.all(ids.map(id => api(`/api/entries/${id}`, { method: "DELETE" }))).then(() => msg && markProposal(msg.chat, msg.id, "rows", null)));
      if (from !== "add") { render(); return; }
      if (a.date !== S.date) goTo(a.date); else load();
    }).catch(e => { S.ui.busy = false; S.ui.error = e.message; render(); });
    return;
  }
  if (kind === "import") {
    S.imp.busy = true; refreshImport();
    send("POST", "/api/import", { text: S.imp.text }).then(res => {
      const ids = res.created.map(x => x.id);
      closeSheet(); loadLists();
      toast(`Imported ${ids.length} ${ids.length === 1 ? "row" : "rows"}${res.duplicates ? `, ${res.duplicates} already logged` : ""}`,
        ids.length ? () => Promise.all(ids.map(id => api(`/api/entries/${id}`, { method: "DELETE" }))) : null);
      if (ids.length) goTo(res.created[0].date); else load();
    }).catch(e => { S.imp.busy = false; S.imp.err = e.message; refreshImport(); });
    return;
  }
  if (kind === "copy") {
    const ids = data.getAll("ids").map(Number), keep = data.get("keep");
    if (!ids.length) { S.ui.error = "Nothing selected."; render(); return; }
    if (!data.get("target")) { S.ui.error = "Pick a day."; render(); return; }
    const target = isoToDmy(data.get("target")), from = S.date;
    const payload = day().entries.filter(x => ids.includes(x.id)).map(x => ({
      date: target, time: keep ? x.time : hm(now()), item: x.item, quantity: x.quantity, calories: x.calories,
      fat_g: x.fat_g, protein_g: x.protein_g, net_carbs_g: x.net_carbs_g, meal: x.meal }));
    S.ui.busy = true;
    send("POST", "/api/entries", payload).then(res => {
      const created = res.created.map(x => x.id);
      closeSheet();
      toast(`Copied ${created.length} from ${from.slice(0, 5)} to ${target.slice(0, 5)}`,
        () => Promise.all(created.map(id => api(`/api/entries/${id}`, { method: "DELETE" }))));
      goTo(target);
    }).catch(e => { S.ui.busy = false; S.ui.error = e.message; render(); });
    return;
  }
  if (kind === "entry") {
    const f = S.form, editing = S.ui.sheet === "edit";
    const entry = {
      date: f.date || S.date, time: f.time || null, item: f.item,
      quantity: f.quantity.trim() ? f.quantity : null,
      net_carbs_g: numOrNull(f.net_carbs_g), calories: numOrNull(f.calories), fat_g: numOrNull(f.fat_g), protein_g: numOrNull(f.protein_g),
      meal: f.meal.trim() ? f.meal : null, notes: f.notes.trim() ? f.notes : null, fasting_hours: numOrNull(f.fasting_hours),
    };
    const bad = !f.item.trim() ? ["Item is required.", "item"]
      : entry.net_carbs_g == null || isNaN(entry.net_carbs_g) ? ["Net carbs is required and must be a number.", "net_carbs_g"]
      : ["calories", "fat_g", "protein_g", "fasting_hours"].some(k => entry[k] != null && isNaN(entry[k])) ? ["Numbers only in calories, fat, protein and fasting hours.", null]
      : null;
    if (bad) {
      S.ui.error = bad[0];
      document.getElementById("form-error").textContent = bad[0];
      if (bad[1]) fm.elements[bad[1]].focus();
      return;
    }
    S.ui.error = ""; S.ui.busy = true;
    const req = editing ? send("PATCH", `/api/entries/${S.ui.editingId}`, entry) : send("POST", "/api/entries", entry);
    req.then(res => {
      S.ui.busy = false;
      loadLists();
      if (editing) {
        closeSheet();
        const moved = res.entry.date !== S.date;
        if (moved) { toast(`Moved to ${res.entry.date.slice(0, 5)}`); goTo(res.entry.date); return null; }
        return load();
      }
      const id = res.created[0].id;
      if (entry.fasting_hours != null) S.pendingFastHours = null;
      toast(["Added ", { u: entry.item }, ` · ${g(entry.net_carbs_g)} g${entry.date !== S.date ? ` to ${entry.date.slice(0, 5)}` : ""}`],
        () => api(`/api/entries/${id}`, { method: "DELETE" }));
      S.form = blankForm({ date: f.date, time: f.time, meal: f.meal });   // date, time, meal stay for the next item
      S.sugg = [];
      return load().then(focusItem);
    }).catch(e => { S.ui.busy = false; S.ui.error = e.message; render(); });
  }
});

document.addEventListener("keydown", ev => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.target.name === "q" && ev.target.form && ev.target.form.dataset.form === "coach") {
    ev.preventDefault(); coachSend(ev.target.value); return;
  }
  if (ev.key === "Escape" && S.ui.sheet) { declineReview(); closeSheet(); render(); }
});

/* Live fast clock: repaint only the glance panel (not while one of its editors is open). */
setInterval(() => {
  if (day().active_fast && !S.ui.goalEdit && !S.ui.fastAdjust) paint("glance", renderGlance(day()));
}, TICK_MS);

window.addEventListener("hashchange", () => { if (hashView() !== S.view) setView(hashView()); });
// iOS Safari ignores user-scalable=no; cancel its pinch gesture as well.
for (const t of ["gesturestart", "gesturechange"]) document.addEventListener(t, ev => ev.preventDefault(), { passive: false });

S.aiFood = blankAiFood();
render();
loadLists();
load();
loadAi();
if (S.view === "insights") loadInsights();
})();
