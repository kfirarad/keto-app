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
function saveTarget(v) { try { localStorage.setItem("keto.fastTarget", String(v)); } catch (e) { /* private mode */ } }

function blankForm(keep) {
  return Object.assign({ item: "", quantity: "", weight: "", base: null, net_carbs_g: "", calories: "", fat_g: "", protein_g: "",
    date: "", time: hm(now()), meal: "", fasting_hours: "", notes: "", suggest: false }, keep || {});
}

const S = {
  date: today(),
  day: null, week: null,
  top: [], foods: [], meals: [], sugg: [],
  fastTarget: loadTarget(),
  pendingFastHours: null,     // hours of a fast just stopped, for the meal that breaks it
  seq: 0,
  ui: { sheet: null, expanded: null, editingId: null, goalEdit: false, fastEditId: null, toast: null,
        copyIds: [], copyTarget: null, error: "", busy: false,
        open: { week: false, fast: false, body: false, form: false } },
  form: blankForm(),
};
const day = () => S.day || EMPTY_DAY;
const entryById = id => day().entries.find(x => x.id === id);

/* ---------- API ---------- */
function api(url, opts) {
  return fetch(url, opts).then(r => r.json().catch(() => ({})).then(body => {
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
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
    S.day = d; S.week = w;
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
  paint("nav", renderNav());
  document.getElementById("glance").className = "glance " + (d.over_goal ? "is-over" : "is-under");
  paint("glance", renderGlance(d));
  paint("quick", renderQuickLog());
  paint("log", renderEntries(d));
  paint("more", renderWeek() + renderFasting(d) + renderBody(d));
  paint("pinbar", renderPinbar(d));
  paint("sheet", renderSheet(d));
  paint("toast", renderToast());
}

function renderGlance(d) { return renderHero(d) + renderGoal(d) + renderFacts(d) + renderFastStrip(d); }

function renderNav() {
  const isToday = S.date === today();
  return `
    <button type="button" class="icon-btn" data-act="day" data-n="-1" aria-label="Previous day">&lsaquo;</button>
    <h1><span class="num">${S.date}</span><small>${weekday(S.date, "long")}</small></h1>
    <button type="button" class="icon-btn" data-act="day" data-n="1" aria-label="Next day">&rsaquo;</button>
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
    return `<button type="button" class="day${c.date === S.date ? " cur" : ""}${over ? " over" : ""}${none ? " none" : ""}" data-act="goto" data-date="${c.date}" aria-label="${sr}"${c.date === S.date ? ' aria-current="date"' : ""}>
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

function renderBody(d) {
  const b = d.body;
  if (!b) return "";
  const sum = [b.weight_kg != null && `${g(b.weight_kg)} kg`, b.ketones_mmol != null && `ketones ${g(b.ketones_mmol)}`,
    b.glucose_mmol != null && `glucose ${g(b.glucose_mmol)}`, b.gki != null && `GKI ${g(b.gki)}`,
    b.water_ml && `${kcal(b.water_ml)} ml water`].filter(Boolean).join(" · ") || "no readings";
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
  const v = k => b[k] == null ? "" : tidy(b[k]);
  return `
    <details data-sec="body"${S.ui.open.body ? " open" : ""}>
      <summary><span class="eyebrow">Body</span><span class="sum num">${sum}</span></summary>
      <div class="panel">
        <form class="grid3" data-form="body" novalidate>
          <label class="field">Weight, kg<input name="weight_kg" inputmode="decimal" value="${v("weight_kg")}"></label>
          <label class="field">Ketones, mmol/L<input name="ketones_mmol" inputmode="decimal" value="${v("ketones_mmol")}"></label>
          <label class="field">Glucose, mmol/L<input name="glucose_mmol" inputmode="decimal" value="${v("glucose_mmol")}"></label>
          <div class="row-btns" style="grid-column:1/-1"><button class="btn btn-primary">Save readings</button></div>
        </form>
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

function renderPinbar(d) {
  if (S.ui.sheet) return "";
  const c = d.totals.net_carbs_g || 0, over = d.over_goal;
  return `<div class="pinbar-in">
    <span class="left tone${over ? " over" : ""}"><b class="num">${g(Math.abs(d.goal - c))} g</b>${over ? "over" : "left"}</span>
    <button type="button" class="btn btn-primary" data-act="open-add">Add food</button></div>`;
}

function renderSheet(d) {
  if (!S.ui.sheet) return "";
  const inner = S.ui.sheet === "copy" ? renderCopyPanel(d) : renderAddForm(d);
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
  SLIDE_PARTS.forEach((sel, i) => {
    const el = document.querySelector(sel);
    if (el && el.animate) el.animate(
      [{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: "none" }],
      { duration: 260, delay: i * 30, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
  });
}

function goTo(date) {
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
    case "close-sheet": closeSheet(); break;
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
  if (kind === "body") {
    const payload = { date: S.date };
    for (const k of ["weight_kg", "ketones_mmol", "glucose_mmol"]) payload[k] = numOrNull(data.get(k));
    S.ui.bodyError = "";
    send("POST", "/api/body", payload).then(() => load()).catch(e => { S.ui.bodyError = e.message; render(); });
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
      toast(`Copied ${created.length} from ${from.slice(0, 5)}`,
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
  if (ev.key === "Escape" && S.ui.sheet) { closeSheet(); render(); }
});

/* Live fast clock: repaint only the glance panel (not while one of its editors is open). */
setInterval(() => {
  if (day().active_fast && !S.ui.goalEdit && !S.ui.fastAdjust) paint("glance", renderGlance(day()));
}, TICK_MS);

render();
loadLists();
load();
})();
