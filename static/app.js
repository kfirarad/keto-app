(function () {
  "use strict";

  var TZ = "Europe/Copenhagen";
  var TICK_MS = 20000;
  var MAX_SUGGEST = 6;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    iso: todayIso(),
    seq: 0,
    day: null,
    active: null,      // running fast, from the server
    editing: null,     // id of the entry loaded into the form
    base: null,        // template the weight field scales from
    foods: [],         // latest row per past item, for suggestions
    top: [],           // most-logged recent items, for the "log again" row
    undo: null,        // function that reverts the last quick action
    toastTimer: null,
    bodyDirty: false,  // body inputs edited and not saved yet
    sugg: [],          // currently shown suggestions
    sel: -1,           // highlighted suggestion
    timeDirty: false,  // user changed the entry time by hand
    fastDirty: false   // user changed the fast moment by hand
  };

  // ---- dates -------------------------------------------------------------

  function todayIso() {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function nowHHMM() {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    var h = "00", m = "00";
    parts.forEach(function (p) {
      if (p.type === "hour") h = p.value;
      if (p.type === "minute") m = p.value;
    });
    return h + ":" + m;
  }

  function isoToDmy(iso) {
    var p = iso.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  function dmyToIso(dmy) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((dmy || "").trim());
    return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
  }

  function shiftIso(iso, days) {
    var p = iso.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.toISOString().slice(0, 10);
  }

  // Native <input type="datetime-local"> uses YYYY-MM-DDTHH:MM; the API uses
  // DD/MM/YYYY plus HH:MM.
  function toLocalInput(dmy, time) {
    return dmy && time ? dmyToIso(dmy) + "T" + time : "";
  }

  function fromLocalInput(v) {
    return v ? { date: isoToDmy(v.slice(0, 10)), time: v.slice(11, 16) } : { date: null, time: null };
  }

  function nowLocalInput() {
    return todayIso() + "T" + nowHHMM();
  }

  function shortMoment(dmy, time) {
    return dmy.slice(0, 5) + " " + time;
  }

  function elapsed(ms) {
    var mins = Math.max(0, Math.floor(ms / 60000));
    var m = mins % 60;
    return Math.floor(mins / 60) + " h " + (m < 10 ? "0" : "") + m + " m";
  }

  // ---- formatting --------------------------------------------------------

  function fmt(x) {
    if (x === null || x === undefined) return "–";
    return String(Math.round(x * 10) / 10);
  }

  function num(s) {
    return parseFloat(String(s).replace(",", "."));
  }

  function tidy(x) {
    return String(Math.round(x * 100) / 100);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function linkButton(label, onClick) {
    var b = el("button", "link", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  // ---- weight scaling ----------------------------------------------------
  // The base weight is the grams named in each top-level "+" part of the
  // quantity, e.g. "3 ביצים (124 גרם) + 18 גרם חמאה" -> 142. Changing the
  // weight scales every number in the quantity and the four macros.

  var GRAM_RE = /(\d+(?:[.,]\d+)?)\s*(?:גרם|גר['׳]?|ג['׳]|grams?|gr?)(?![A-Za-z֐-׿])/i;
  var NUM_RE = /\d+(?:[.,]\d+)?(?![\d.,]*\s*%)/g;
  var MACROS = { net_carbs_g: "f-net", calories: "f-cal", fat_g: "f-fat", protein_g: "f-protein" };

  function topLevelParts(q) {
    var parts = [], depth = 0, cur = "";
    for (var i = 0; i < q.length; i++) {
      var ch = q.charAt(i);
      if (ch === "(") depth++;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "+" && depth === 0) { parts.push(cur); cur = ""; } else { cur += ch; }
    }
    parts.push(cur);
    return parts;
  }

  function gramsIn(q) {
    if (!q) return null;
    var total = 0, found = false;
    topLevelParts(q).forEach(function (p) {
      var m = GRAM_RE.exec(p);
      if (m) { total += num(m[1]); found = true; }
    });
    return found && total > 0 ? total : null;
  }

  function setBase(src) {
    var vals = {};
    Object.keys(MACROS).forEach(function (k) { vals[k] = src[k]; });
    state.base = { quantity: src.quantity || "", grams: gramsIn(src.quantity), vals: vals };
    var b = state.base;
    $("f-weight-label").textContent = b.grams ? "Weight g" : "Portions";
    $("f-weight").value = b.grams ? tidy(b.grams) : "1";
    $("scale-base").textContent = b.grams
      ? "was " + tidy(b.grams) + " g"
      : "no grams in quantity";
    $("scale").hidden = false;
  }

  function clearBase() {
    state.base = null;
    $("scale").hidden = true;
    $("f-weight").value = "";
  }

  function applyScale() {
    var b = state.base;
    if (!b) return;
    var v = num($("f-weight").value);
    if (!isFinite(v) || v <= 0) return;
    var factor = b.grams ? v / b.grams : v;
    if (b.quantity) {
      $("f-quantity").value = b.quantity.replace(NUM_RE, function (m) { return tidy(num(m) * factor); });
    }
    Object.keys(MACROS).forEach(function (k) {
      var base = b.vals[k];
      $(MACROS[k]).value = base === null || base === undefined ? "" : tidy(base * factor);
    });
    updatePreview();
  }

  function applyPortion(m) {
    var b = state.base;
    if (!b) return;
    $("f-weight").value = tidy(b.grams ? b.grams * m : m);
    applyScale();
  }

  // ---- render ------------------------------------------------------------

  function renderDay(day) {
    state.day = day;
    var t = day.totals;
    var net = t.net_carbs_g || 0;
    var over = day.over_goal;

    $("date").textContent = day.date;
    $("today").disabled = state.iso === todayIso();
    document.body.classList.toggle("over", over);

    $("net").textContent = fmt(net);
    $("goal").textContent = fmt(day.goal);
    $("bar").style.width = Math.min(100, (net / day.goal) * 100) + "%";
    $("status").textContent = over
      ? fmt(net - day.goal) + " g over goal"
      : fmt(day.remaining) + " g remaining";

    renderSecondary(day);

    renderGoal(day);
    renderFasting(day);
    renderBody(day.body);
    renderEntries(day.entries);
    $("entries-head").hidden = day.count === 0;
    closeCopy();
    renderQuick();
    updatePreview();
  }

  // Macros with their share of energy (fat 9 kcal/g, protein and carbs 4),
  // then the eating window and fasting hours.
  function renderSecondary(day) {
    var t = day.totals;
    $("secondary").hidden = day.count === 0;
    if (day.count === 0) return;
    var fatK = (t.fat_g || 0) * 9, proK = (t.protein_g || 0) * 4, carbK = (t.net_carbs_g || 0) * 4;
    var sum = fatK + proK + carbK;
    function pct(k) { return sum > 0 ? " (" + Math.round(k / sum * 100) + "%)" : ""; }
    var bits = [
      fmt(t.calories) + " kcal",
      "fat " + fmt(t.fat_g) + " g" + (t.fat_g !== null ? pct(fatK) : ""),
      "protein " + fmt(t.protein_g) + " g" + (t.protein_g !== null ? pct(proK) : ""),
      "carbs" + (sum > 0 ? pct(carbK) : " " + fmt(t.net_carbs_g) + " g")
    ];
    $("macros").textContent = bits.join(" · ");

    var times = day.entries.filter(function (e) {
      return e.time && ((e.calories || 0) > 0 || e.net_carbs_g > 0);
    }).map(function (e) { return e.time; }).sort();
    var win = [];
    if (times.length) {
      var span = minutes(times[times.length - 1]) - minutes(times[0]);
      win.push("Eating " + times[0] + "–" + times[times.length - 1] +
        (span > 0 ? " (" + elapsed(span * 60000) + ")" : ""));
    }
    if (t.fasting_hours !== null) win.push(fmt(t.fasting_hours) + " h fasting");
    $("window").textContent = win.join(" · ");
    $("window").hidden = !win.length;
  }

  // ---- body readings -----------------------------------------------------

  var BODY_INPUTS = { weight_kg: "b-weight", ketones_mmol: "b-ket", glucose_mmol: "b-glu" };

  function signed(x) {
    return (x > 0 ? "+" : x < 0 ? "\u2212" : "\u00b1") + fmt(Math.abs(x));
  }

  function renderBody(b) {
    if (!state.bodyDirty) {
      Object.keys(BODY_INPUTS).forEach(function (k) {
        $(BODY_INPUTS[k]).value = b[k] === null ? "" : tidy(b[k]);
      });
    }
    var stats = [];
    if (b.weight_change_kg !== null) {
      stats.push(signed(b.weight_change_kg) + " kg since " + b.previous_weight.date.slice(0, 5));
    }
    if (b.gki !== null) stats.push("GKI " + fmt(b.gki) + ", " + b.gki_band);
    $("body-stats").textContent = stats.join(" · ");

    var spark = $("spark");
    spark.toggleAttribute("hidden", b.weights.length < 2);  // SVG has no .hidden property
    if (b.weights.length >= 2) {
      var ws = b.weights.map(function (w) { return w.weight_kg; });
      var lo = Math.min.apply(null, ws), hi = Math.max.apply(null, ws), span = hi - lo || 1;
      $("spark-line").setAttribute("points", ws.map(function (w, i) {
        return (i / (ws.length - 1) * 100).toFixed(2) + "," + (22 - (w - lo) / span * 20).toFixed(2);
      }).join(" "));
    }

    var water = b.water_ml || 0;
    $("water").textContent = "Water " + fmt(water) + " ml";

    var bits = [];
    if (b.weight_kg !== null) bits.push(fmt(b.weight_kg) + " kg");
    if (b.ketones_mmol !== null) bits.push("ketones " + fmt(b.ketones_mmol));
    if (b.glucose_mmol !== null) bits.push("glucose " + fmt(b.glucose_mmol));
    if (b.gki !== null) bits.push("GKI " + fmt(b.gki));
    if (water) bits.push(fmt(water) + " ml water");
    var sum = $("body-sum");
    sum.textContent = "Body";
    var span_ = el("span", "more-bits", bits.length ? bits.join(" · ") : "weight, ketones, glucose, water");
    sum.appendChild(document.createTextNode(" "));
    sum.appendChild(span_);
  }

  function saveBody(payload) {
    payload.date = isoToDmy(state.iso);
    $("body-error").textContent = "";
    return sendJSON("POST", "/api/body", payload).then(function () {
      state.bodyDirty = false;
      return load();
    }).catch(function (e) { $("body-error").textContent = e.message; });
  }

  // ---- last 7 days -------------------------------------------------------

  function weekday(iso) {
    return new Date(iso + "T12:00:00Z")
      .toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).slice(0, 2);
  }

  function renderWeek(o) {
    var box = $("week-bars");
    box.textContent = "";
    var max = 0;
    o.days.forEach(function (d) { max = Math.max(max, d.totals.net_carbs_g || 0, d.goal); });
    max *= 1.1;
    o.days.forEach(function (d) {
      var iso = dmyToIso(d.date), net = d.totals.net_carbs_g || 0;
      var b = el("button", "wday" + (iso === state.iso ? " cur" : "") +
        (d.over_goal ? " over" : "") + (d.count ? "" : " empty"));
      b.type = "button";
      b.setAttribute("aria-label", d.date + ": " +
        (d.count ? fmt(net) + " of " + fmt(d.goal) + " g" : "no entries"));
      b.appendChild(el("span", "wval", d.count ? fmt(net) : "–"));
      var col = el("span", "wcol");
      var bar = el("span", "wbar");
      bar.style.height = (d.count ? net / max * 100 : 0) + "%";
      var goal = el("span", "wgoal");
      goal.style.bottom = (d.goal / max * 100) + "%";
      col.appendChild(bar);
      col.appendChild(goal);
      b.appendChild(col);
      b.appendChild(el("span", "wlabel", weekday(iso) + " " + d.date.slice(0, 2)));
      b.addEventListener("click", function () { go(iso); });
      box.appendChild(b);
    });

    var stats = [];
    if (o.logged_days) {
      stats.push("7-day avg " + fmt(o.average_net_carbs_g) + " g");
      stats.push(o.within_goal_days + " of " + o.logged_days + " days within goal");
    }
    stats.push("streak " + o.streak.current + (o.streak.current === 1 ? " day" : " days") +
      ", best " + o.streak.best);
    $("week-stats").textContent = stats.join(" · ");
    $("week").hidden = false;
  }

  // ---- daily goal --------------------------------------------------------

  var GOAL_SOURCE = {
    set: "set for this day",
    inherited: "carried over",
    "default": "default"
  };

  function renderGoal(day) {
    $("goal-src").textContent = "Goal " + fmt(day.goal) + " g, " + GOAL_SOURCE[day.goal_source];
    $("goal-reset").hidden = day.goal_source !== "set";
  }

  function openGoal() {
    if (!state.day) return;
    $("goal-input").value = state.day.goal;
    $("goal-error").textContent = "";
    $("goal-line").hidden = true;
    $("goal-form").hidden = false;
    $("goal-input").focus();
    $("goal-input").select();
  }

  function closeGoal() {
    $("goal-form").hidden = true;
    $("goal-line").hidden = false;
  }

  function saveGoal(value) {
    $("goal-error").textContent = "";
    sendJSON("POST", "/api/goal", { date: isoToDmy(state.iso), net_carbs_goal: value })
      .then(function () { closeGoal(); return load(); })
      .catch(function (e) { $("goal-error").textContent = e.message; });
  }

  function renderEntries(entries) {
    var box = $("entries");
    box.textContent = "";
    if (!entries.length) {
      box.appendChild(el("p", "empty", "No entries."));
      return;
    }
    var grouped = entries.some(function (e) { return e.meal; });
    if (!grouped) {
      box.appendChild(renderList(entries));
      return;
    }
    var order = [], groups = {};
    entries.forEach(function (e) {
      var key = e.meal || "";
      if (!(key in groups)) { groups[key] = []; order.push(key); }
      groups[key].push(e);
    });
    order.forEach(function (key) {
      var list = groups[key];
      var h = el("h2", "meal");
      var name = el("span", "meal-name", key || "No meal");
      name.dir = "auto";
      h.appendChild(name);
      var sum = list.reduce(function (acc, e) { return acc + e.net_carbs_g; }, 0);
      h.appendChild(el("span", "meal-sum", fmt(sum) + " g"));
      var copy = linkButton("Copy", function () { openCopy(list); });
      copy.setAttribute("aria-label", "Copy " + (key || "entries without a meal"));
      h.appendChild(copy);
      box.appendChild(h);
      box.appendChild(renderList(list));
    });
  }

  function renderList(entries) {
    var ol = el("ol");
    entries.forEach(function (e) { ol.appendChild(renderRow(e)); });
    return ol;
  }

  function renderRow(e) {
    var li = el("li", "row" + (state.editing === e.id ? " editing" : ""));
    li.appendChild(el("span", "time", e.time || ""));

    var body = el("div", "body");
    var head = el("p");
    var item = el("span", "item", e.item);
    item.dir = "auto";
    head.appendChild(item);
    if (e.quantity) {
      head.appendChild(document.createTextNode(" "));
      var q = el("span", "qty", e.quantity);
      q.dir = "auto";
      head.appendChild(q);
    }
    body.appendChild(head);

    if (e.notes) {
      var n = el("p", "notes", e.notes);
      n.dir = "auto";
      body.appendChild(n);
    }

    var meta = el("div", "meta");
    var nums = [fmt(e.calories) + " kcal", "F " + fmt(e.fat_g), "P " + fmt(e.protein_g)];
    if (e.fasting_hours !== null) nums.push(fmt(e.fasting_hours) + " h fast");
    meta.appendChild(el("span", "nums", nums.join(" · ")));
    var acts = el("span", "acts");
    acts.appendChild(linkButton("Edit", function () { startEdit(e); }));
    acts.appendChild(linkButton("Delete", function () { deleteEntry(e); }));
    meta.appendChild(acts);
    body.appendChild(meta);

    li.appendChild(body);
    li.appendChild(el("span", "carbs", fmt(e.net_carbs_g) + " g"));
    return li;
  }

  // ---- copy entries to another day ---------------------------------------

  function openCopy(entries) {
    var panel = $("copy-panel");
    panel.textContent = "";
    panel.appendChild(el("h2", "copy-title", "Copy to another day"));

    var form = el("form");
    form.noValidate = true;
    var ul = el("ul", "copy-list");
    var boxes = entries.map(function (e) {
      var li = el("li");
      var label = el("label");
      var cb = el("input");
      cb.type = "checkbox";
      cb.checked = true;
      label.appendChild(cb);
      label.appendChild(el("span", "copy-time", e.time || ""));
      var text = el("span", "copy-item", e.item + (e.quantity ? " · " + e.quantity : ""));
      text.dir = "auto";
      label.appendChild(text);
      label.appendChild(el("span", "copy-carbs", fmt(e.net_carbs_g) + " g"));
      li.appendChild(label);
      ul.appendChild(li);
      return cb;
    });
    form.appendChild(ul);

    var opts = el("div", "copy-opts");
    var dl = el("label", null, "To ");
    var date = el("input");
    date.type = "date";
    var today = todayIso();
    date.value = state.iso === today ? shiftIso(today, 1) : today;
    dl.appendChild(date);
    opts.appendChild(dl);
    var tl = el("label");
    var keep = el("input");
    keep.type = "checkbox";
    keep.checked = true;
    tl.appendChild(keep);
    tl.appendChild(document.createTextNode(" keep times"));
    opts.appendChild(tl);
    form.appendChild(opts);

    var btns = el("div", "copy-btns");
    var copyBtn = el("button", "primary", "Copy");
    copyBtn.type = "submit";
    var err = el("p", "error");
    btns.appendChild(copyBtn);
    btns.appendChild(linkButton("Cancel", closeCopy));
    btns.appendChild(err);
    form.appendChild(btns);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var chosen = entries.filter(function (e, i) { return boxes[i].checked; });
      if (!chosen.length) { err.textContent = "Nothing selected."; return; }
      if (!date.value) { err.textContent = "Pick a date."; return; }
      var target = isoToDmy(date.value);
      var payload = chosen.map(function (e) {
        return {
          date: target, time: keep.checked ? e.time : null, item: e.item, quantity: e.quantity,
          calories: e.calories, fat_g: e.fat_g, protein_g: e.protein_g,
          net_carbs_g: e.net_carbs_g, meal: e.meal
        };
      });
      copyBtn.disabled = true;
      sendJSON("POST", "/api/entries", payload).then(function (res) {
        var ids = res.created.map(function (r) { return r.id; });
        closeCopy();
        go(date.value);
        loadFoods();
        toast("Copied " + ids.length + " to " + target.slice(0, 5), function () {
          return Promise.all(ids.map(function (id) {
            return api("/api/entries/" + id, { method: "DELETE" });
          }));
        });
      }).catch(function (e) {
        err.textContent = e.message;
        copyBtn.disabled = false;
      });
    });

    panel.appendChild(form);
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeCopy() {
    $("copy-panel").hidden = true;
    $("copy-panel").textContent = "";
  }

  // ---- one-tap "log again" -----------------------------------------------

  function renderQuick() {
    var box = $("chips");
    box.textContent = "";
    state.top.forEach(function (f) {
      var b = el("button", "chip");
      b.type = "button";
      var name = el("span", "chip-item", f.item);
      name.dir = "auto";
      b.appendChild(name);
      b.appendChild(el("span", "chip-carbs", fmt(f.net_carbs_g) + " g"));
      b.title = (f.quantity || "") + " · " + fmt(f.net_carbs_g) + " g net carbs";
      b.addEventListener("click", function () { quickLog(f, b); });
      box.appendChild(b);
    });
    $("quick").hidden = !state.top.length || state.editing !== null;
  }

  function minutes(hhmm) {
    var p = hhmm.split(":");
    return Number(p[0]) * 60 + Number(p[1]);
  }

  // The meal of the latest entry this day logged up to two hours before `time`.
  function guessMeal(time) {
    if (!time || !state.day) return null;
    var t = minutes(time), best = null;
    state.day.entries.forEach(function (e) {
      if (!e.meal || !e.time) return;
      var d = t - minutes(e.time);
      if (d >= 0 && d <= 120 && (best === null || d < best.d)) best = { d: d, meal: e.meal };
    });
    return best ? best.meal : null;
  }

  function quickLog(f, btn) {
    var time = state.iso === todayIso() ? nowHHMM() : ($("f-time").value || null);
    var entry = {
      date: isoToDmy(state.iso), time: time, item: f.item, quantity: f.quantity,
      calories: f.calories, fat_g: f.fat_g, protein_g: f.protein_g, net_carbs_g: f.net_carbs_g,
      meal: guessMeal(time) || $("f-meal").value.trim() || null
    };
    btn.disabled = true;
    sendJSON("POST", "/api/entries", entry).then(function (res) {
      var id = res.created[0].id;
      toast("Added " + f.item, function () {
        return api("/api/entries/" + id, { method: "DELETE" });
      });
      loadFoods();
      return load();
    }).catch(function (e) {
      showError(e.message);
    }).then(function () {
      btn.disabled = false;
    });
  }

  // ---- toast with undo ---------------------------------------------------

  function toast(msg, undo) {
    var t = $("toast");
    $("toast-msg").textContent = msg;
    $("toast-msg").dir = "auto";
    state.undo = undo || null;
    $("toast-undo").hidden = !undo;
    t.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, 8000);
  }

  function hideToast() {
    $("toast").hidden = true;
    state.undo = null;
  }

  function runUndo() {
    var undo = state.undo;
    hideToast();
    if (!undo) return;
    undo().then(function () {
      loadFoods();
      return load();
    }).catch(function (e) { showError(e.message); });
  }

  // ---- add form helpers --------------------------------------------------

  // "After this: 17.5 / 20 g" for the day shown, before saving.
  function updatePreview() {
    var p = $("preview"), d = state.day;
    var v = num($("f-net").value);
    if (!d || !isFinite(v) || ($("f-date").value && $("f-date").value !== state.iso)) {
      p.textContent = "";
      return;
    }
    var cur = d.totals.net_carbs_g || 0;
    if (state.editing !== null) {
      d.entries.forEach(function (e) { if (e.id === state.editing) cur -= e.net_carbs_g; });
    }
    var after = cur + v, left = d.goal - after;
    p.textContent = "After this: " + fmt(after) + " / " + fmt(d.goal) + " g, " +
      (left >= 0 ? fmt(left) + " g left" : fmt(-left) + " g over");
    p.classList.toggle("over", left < 0);
  }

  function applyLabel() {
    var total = num($("c-total").value);
    if (!isFinite(total)) return;
    var fiber = num($("c-fiber").value), sa = num($("c-sa").value);
    var net = total - (isFinite(fiber) ? fiber : 0) - (isFinite(sa) ? sa : 0);
    $("f-net").value = tidy(Math.max(0, net));
    updatePreview();
  }

  function updateMoreSummary() {
    var bits = [];
    var d = $("f-date").value;
    if (d) bits.push(d === state.iso ? isoToDmy(d).slice(0, 5) : isoToDmy(d));
    if ($("f-time").value) bits.push($("f-time").value);
    if ($("f-meal").value.trim()) bits.push($("f-meal").value.trim());
    if ($("f-fast").value.trim()) bits.push($("f-fast").value.trim() + " h fast");
    if ($("f-notes").value.trim()) bits.push("note");
    var s = $("more-sum");
    s.textContent = "More";
    if (bits.length) {
      var span = el("span", "more-bits", bits.join(" · "));
      span.dir = "auto";
      s.appendChild(document.createTextNode(" "));
      s.appendChild(span);
    }
  }

  // ---- fasting -----------------------------------------------------------

  function renderFasting(day) {
    state.active = day.active_fast;
    var btn = $("fast-btn");
    btn.textContent = state.active ? "Stop fasting" : "Start fasting";
    tickFast();

    var ol = $("fasts");
    ol.textContent = "";
    var list = (state.active ? [state.active] : []).concat(day.fasts);
    list.forEach(function (f) { ol.appendChild(renderFastRow(f)); });
    ol.hidden = !list.length;
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function fastTarget() {
    var v = storageGet("keto.fastTarget");
    return v === null ? 16 : Number(v) || 0;
  }

  function tickFast() {
    var a = state.active, s = $("fast-state");
    var target = fastTarget(), prog = $("fast-progress");
    prog.hidden = !(a && target);
    if (a && target) {
      var ms = Date.now() - Date.parse(a.start_at), goalMs = target * 3600000;
      $("fp-fill").style.width = Math.min(100, ms / goalMs * 100) + "%";
      prog.classList.toggle("done", ms >= goalMs);
      $("fp-text").textContent = ms < goalMs
        ? elapsed(goalMs - ms) + " to " + target + " h"
        : target + " h reached " + elapsed(ms - goalMs) + " ago";
    }
    if (a) {
      s.textContent = "Fasting " + elapsed(Date.now() - Date.parse(a.start_at)) +
        " · since " + shortMoment(a.start_date, a.start_time);
      s.classList.add("on");
    } else {
      s.textContent = "Not fasting";
      s.classList.remove("on");
    }
  }

  function resetFastInputs() {
    var now = nowLocalInput();
    $("fast-at").value = now;
    $("fast-at").max = now;
    state.fastDirty = false;
  }

  function renderFastRow(f) {
    var li = el("li", "frow");
    var line = el("p", "fline");
    if (f.active) {
      line.appendChild(el("span", "fdur", "Running"));
      line.appendChild(el("span", "fspan", "since " + shortMoment(f.start_date, f.start_time)));
    } else {
      line.appendChild(el("span", "fdur", fmt(f.hours) + " h fast"));
      line.appendChild(el("span", "fspan",
        shortMoment(f.start_date, f.start_time) + " → " + shortMoment(f.end_date, f.end_time)));
    }
    li.appendChild(line);
    if (f.notes) {
      var n = el("p", "notes", f.notes);
      n.dir = "auto";
      li.appendChild(n);
    }
    var acts = el("p", "acts");
    acts.appendChild(linkButton("Edit", function () { editFast(li, f); }));
    acts.appendChild(linkButton("Delete", function () { deleteFast(f); }));
    li.appendChild(acts);
    return li;
  }

  function editFast(li, f) {
    li.textContent = "";
    var form = el("form", "fedit");
    form.noValidate = true;
    function field(label, value, attrs) {
      var l = el("label", null, label);
      var i = el("input");
      Object.keys(attrs).forEach(function (k) { i.setAttribute(k, attrs[k]); });
      i.value = value || "";
      l.appendChild(i);
      form.appendChild(l);
      return i;
    }
    var max = nowLocalInput();
    var start = field("Start", toLocalInput(f.start_date, f.start_time), { type: "datetime-local", max: max });
    var end = field(f.active ? "End (empty while running)" : "End",
                    toLocalInput(f.end_date, f.end_time), { type: "datetime-local", max: max });
    var nt = field("Notes", f.notes, { dir: "auto" });
    nt.parentNode.className = "wide";

    var btns = el("div", "fbtns wide");
    var save = el("button", "primary", "Save");
    save.type = "submit";
    var err = el("p", "error");
    btns.appendChild(save);
    btns.appendChild(linkButton("Cancel", function () { li.replaceWith(renderFastRow(f)); }));
    btns.appendChild(err);
    form.appendChild(btns);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      save.disabled = true;
      err.textContent = "";
      var s = fromLocalInput(start.value), e = fromLocalInput(end.value);
      sendJSON("PATCH", "/api/fasts/" + f.id, {
        start_date: s.date,
        start_time: s.time,
        end_date: e.date,
        end_time: e.time,
        notes: nt.value.trim() ? nt.value : null
      }).then(function () {
        return load();
      }).catch(function (e) {
        err.textContent = e.message;
        save.disabled = false;
      });
    });
    li.appendChild(form);
    start.focus();
  }

  function deleteFast(f) {
    var what = f.active ? "the running fast" : "this " + fmt(f.hours) + " h fast";
    if (!window.confirm("Delete " + what + "?")) return;
    api("/api/fasts/" + f.id, { method: "DELETE" })
      .then(function () { return load(); })
      .catch(function (e) { $("fast-error").textContent = e.message; });
  }

  function toggleFast() {
    var stopping = !!state.active;
    var btn = $("fast-btn");
    $("fast-error").textContent = "";
    $("fast-note").textContent = "";
    btn.disabled = true;
    var at = fromLocalInput($("fast-at").value);  // empty means now
    sendJSON("POST", stopping ? "/api/fasts/stop" : "/api/fasts/start", {
      date: at.date,
      time: at.time
    }).then(function (res) {
      resetFastInputs();
      if (stopping && res.fast.hours !== null) {
        var note = "Fast ended after " + fmt(res.fast.hours) + " h.";
        if ($("f-fast").value.trim() === "" && state.editing === null) {
          $("f-fast").value = fmt(res.fast.hours);
          $("more").open = true;
          updateMoreSummary();
          note += " Prefilled as fasting hours for the entry that breaks it.";
        }
        $("fast-note").textContent = note;
      }
      return load();
    }).catch(function (e) {
      $("fast-error").textContent = e.message;
    }).then(function () {
      btn.disabled = false;
    });
  }

  // ---- data --------------------------------------------------------------

  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
        return body;
      });
    });
  }

  function sendJSON(method, url, body) {
    return api(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  function load() {
    var seq = ++state.seq;
    $("date").textContent = isoToDmy(state.iso);
    api("/api/days?n=7&end=" + encodeURIComponent(isoToDmy(state.iso)))
      .then(function (o) { if (seq === state.seq) renderWeek(o); })
      .catch(function () { /* the strip is optional */ });
    return api("/api/day?date=" + encodeURIComponent(isoToDmy(state.iso)))
      .then(function (day) { if (seq === state.seq) renderDay(day); })
      .catch(function (err) { if (seq === state.seq) showError(err.message); });
  }

  function loadFoods() {
    // Suggestions, the "log again" row and meal names are optional extras.
    api("/api/foods?top=8")
      .then(function (top) { state.top = top; renderQuick(); })
      .catch(function () {});
    api("/api/meals").then(function (meals) {
      var dl = $("meals");
      dl.textContent = "";
      meals.forEach(function (m) { var o = el("option"); o.value = m; dl.appendChild(o); });
    }).catch(function () {});
    return api("/api/foods")
      .then(function (foods) { state.foods = foods; })
      .catch(function () {});
  }

  function go(iso) {
    state.iso = iso;
    state.bodyDirty = false;
    closeGoal();
    if (state.editing === null) {
      $("f-date").value = iso;
      updateMoreSummary();
    }
    showError("");
    load();
  }

  function showError(msg) { $("error").textContent = msg; }

  // ---- suggestions from past entries -------------------------------------

  function updateSuggest() {
    var q = $("f-item").value.trim().toLowerCase();
    var box = $("suggest");
    state.sel = -1;
    if (!q || state.editing !== null) { hideSuggest(); return; }
    var starts = [], rest = [];
    state.foods.forEach(function (f) {
      var name = f.item.toLowerCase();
      if (name.indexOf(q) === 0) starts.push(f);
      else if (name.indexOf(q) > 0) rest.push(f);
    });
    state.sugg = starts.concat(rest).slice(0, MAX_SUGGEST);
    if (state.sugg.length === 1 && state.sugg[0].item === $("f-item").value && state.base) {
      state.sugg = [];
    }
    box.textContent = "";
    state.sugg.forEach(function (f, i) {
      var li = el("li");
      var b = el("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", "false");
      var name = el("span", "s-item", f.item + (f.quantity ? " · " + f.quantity : ""));
      name.dir = "auto";
      b.appendChild(name);
      b.appendChild(el("span", "s-meta", fmt(f.net_carbs_g) + " g · " + f.last_date.slice(0, 5)));
      b.addEventListener("click", function () { pickFood(state.sugg[i]); });
      li.appendChild(b);
      box.appendChild(li);
    });
    box.hidden = !state.sugg.length;
  }

  function hideSuggest() {
    $("suggest").hidden = true;
    state.sugg = [];
    state.sel = -1;
  }

  function highlight(i) {
    var buttons = $("suggest").querySelectorAll("button");
    state.sel = i;
    for (var k = 0; k < buttons.length; k++) {
      buttons[k].setAttribute("aria-selected", k === i ? "true" : "false");
    }
  }

  function pickFood(f) {
    $("f-item").value = f.item;
    $("f-quantity").value = f.quantity || "";
    Object.keys(MACROS).forEach(function (k) {
      $(MACROS[k]).value = f[k] === null ? "" : tidy(f[k]);
    });
    setBase(f);
    hideSuggest();
    updatePreview();
    $("f-weight").focus();
    $("f-weight").select();
  }

  // ---- form --------------------------------------------------------------

  var TEXT = { item: "f-item", quantity: "f-quantity", meal: "f-meal", notes: "f-notes", time: "f-time" };
  var NUM = { net_carbs_g: "f-net", calories: "f-cal", fat_g: "f-fat", protein_g: "f-protein", fasting_hours: "f-fast" };

  function readForm(withNulls) {
    var out = { date: isoToDmy($("f-date").value || state.iso) };
    Object.keys(TEXT).forEach(function (k) {
      var v = $(TEXT[k]).value;
      if (v.trim() !== "") out[k] = v;
      else if (withNulls) out[k] = null;
    });
    Object.keys(NUM).forEach(function (k) {
      var v = $(NUM[k]).value.trim().replace(",", ".");
      if (v !== "") out[k] = v;
      else if (withNulls) out[k] = null;
    });
    return out;
  }

  var LABEL_FIELDS = ["c-total", "c-fiber", "c-sa"];

  function resetForm() {
    ["f-item", "f-quantity", "f-notes", "f-net", "f-cal", "f-fat", "f-protein", "f-meal", "f-fast"]
      .concat(LABEL_FIELDS)
      .forEach(function (id) { $(id).value = ""; });
    $("f-date").value = state.iso;
    $("f-time").value = nowHHMM();
    state.timeDirty = false;
    clearBase();
    updateMoreSummary();
    updatePreview();
  }

  function setEditMode(entry) {
    state.editing = entry ? entry.id : null;
    var mode = $("form-mode");
    mode.textContent = "";
    if (entry) {
      mode.appendChild(document.createTextNode("Editing: "));
      var b = el("bdi", null, entry.item);
      mode.appendChild(b);
    }
    mode.hidden = !entry;
    $("save").textContent = entry ? "Save" : "Add";
    $("cancel").hidden = !entry;
    renderQuick();
  }

  function startEdit(e) {
    hideSuggest();
    setEditMode(e);
    $("f-item").value = e.item;
    $("f-quantity").value = e.quantity || "";
    $("f-meal").value = e.meal || "";
    $("f-notes").value = e.notes || "";
    $("f-date").value = dmyToIso(e.date);
    $("f-time").value = e.time || "";
    Object.keys(NUM).forEach(function (k) {
      $(NUM[k]).value = e[k] === null ? "" : tidy(e[k]);
    });
    setBase(e);
    LABEL_FIELDS.forEach(function (id) { $(id).value = ""; });
    $("more").open = true;
    updateMoreSummary();
    updatePreview();
    showError("");
    if (state.day) renderEntries(state.day.entries);
    $("form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("f-item").focus({ preventScroll: true });
  }

  function cancelEdit() {
    setEditMode(null);
    resetForm();
    showError("");
    if (state.day) renderEntries(state.day.entries);
  }

  function deleteEntry(e) {
    if (!window.confirm("Delete “" + e.item + "”?")) return;
    api("/api/entries/" + e.id, { method: "DELETE" }).then(function () {
      if (state.editing === e.id) { setEditMode(null); resetForm(); }
      loadFoods();
      return load();
    }).catch(function (err) { showError(err.message); });
  }

  function submit(ev) {
    ev.preventDefault();
    hideSuggest();
    var editing = state.editing;
    var entry = readForm(editing !== null);
    if (!entry.item) { showError("Item is required."); $("f-item").focus(); return; }
    if (entry.net_carbs_g === undefined || entry.net_carbs_g === null || !isFinite(Number(entry.net_carbs_g))) {
      showError("Net carbs is required and must be a number."); $("f-net").focus(); return;
    }
    Object.keys(NUM).forEach(function (k) {
      if (entry[k] !== undefined && entry[k] !== null && isFinite(Number(entry[k]))) entry[k] = Number(entry[k]);
    });
    showError("");
    $("save").disabled = true;
    var req = editing !== null
      ? sendJSON("PATCH", "/api/entries/" + editing, entry)
      : sendJSON("POST", "/api/entries", entry);
    req.then(function (res) {
      var savedDate = editing !== null ? res.entry.date : res.created[0].date;
      if (editing !== null) {
        setEditMode(null);
        resetForm();
      } else {
        // Keep date, time, meal and macros; the fasting hours belong to one row only.
        ["f-item", "f-quantity", "f-notes", "f-fast"].concat(LABEL_FIELDS)
          .forEach(function (id) { $(id).value = ""; });
        clearBase();
        updateMoreSummary();
      }
      $("fast-note").textContent = "";
      $("f-item").focus();
      loadFoods();
      var iso = dmyToIso(savedDate);
      if (iso && iso !== state.iso) { go(iso); return null; }
      return load();
    }).catch(function (err) {
      showError(err.message);
    }).then(function () {
      $("save").disabled = false;
    });
  }

  // ---- wire up -----------------------------------------------------------

  $("prev").addEventListener("click", function () { go(shiftIso(state.iso, -1)); });
  $("next").addEventListener("click", function () { go(shiftIso(state.iso, 1)); });
  $("today").addEventListener("click", function () { go(todayIso()); });
  $("form").addEventListener("submit", submit);
  $("cancel").addEventListener("click", cancelEdit);
  $("fast-btn").addEventListener("click", toggleFast);
  $("f-weight").addEventListener("input", applyScale);
  Array.prototype.forEach.call(document.querySelectorAll(".portions button"), function (b) {
    b.addEventListener("click", function () { applyPortion(Number(b.getAttribute("data-m"))); });
  });
  LABEL_FIELDS.forEach(function (id) { $(id).addEventListener("input", applyLabel); });
  $("f-net").addEventListener("input", updatePreview);
  ["f-date", "f-time", "f-meal", "f-fast", "f-notes"].forEach(function (id) {
    $(id).addEventListener("input", updateMoreSummary);
    $(id).addEventListener("change", updateMoreSummary);
  });
  $("f-date").addEventListener("change", updatePreview);
  $("copy-open").addEventListener("click", function () {
    if (state.day) openCopy(state.day.entries);
  });
  $("toast-undo").addEventListener("click", runUndo);
  $("body-form").addEventListener("input", function () { state.bodyDirty = true; });
  $("body-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var payload = {};
    Object.keys(BODY_INPUTS).forEach(function (k) {
      var v = $(BODY_INPUTS[k]).value.trim().replace(",", ".");
      payload[k] = v === "" ? null : Number(v);
    });
    saveBody(payload);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".water button"), function (b) {
    b.addEventListener("click", function () {
      saveBody({ add_water_ml: Number(b.getAttribute("data-ml")) });
    });
  });
  $("fast-target").value = String(fastTarget() || "");
  $("fast-target").addEventListener("change", function () {
    storageSet("keto.fastTarget", $("fast-target").value || "0");
    tickFast();
  });
  $("fab").addEventListener("click", function () {
    $("form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("f-item").focus({ preventScroll: true });
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (items) {
      $("fab").hidden = items[0].isIntersecting;
    }).observe($("form"));
  }
  $("goal-edit").addEventListener("click", openGoal);
  $("goal-cancel").addEventListener("click", closeGoal);
  $("goal-reset").addEventListener("click", function () { saveGoal(null); });
  $("goal-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("goal-input").value.trim().replace(",", ".");
    if (v === "" || !isFinite(Number(v)) || Number(v) <= 0) {
      $("goal-error").textContent = "Goal must be a number above 0.";
      return;
    }
    saveGoal(Number(v));
  });

  $("f-item").addEventListener("input", function () {
    if ($("f-item").value.trim() === "") clearBase();
    updateSuggest();
  });
  $("f-item").addEventListener("blur", function () { setTimeout(hideSuggest, 200); });
  $("f-item").addEventListener("keydown", function (ev) {
    var n = state.sugg.length;
    if (ev.key === "ArrowDown" && n) { ev.preventDefault(); highlight((state.sel + 1) % n); return; }
    if (ev.key === "ArrowUp" && n) { ev.preventDefault(); highlight((state.sel - 1 + n) % n); return; }
    if (ev.key === "Escape" && n) { hideSuggest(); return; }
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      if (state.sel >= 0 && state.sugg[state.sel]) { pickFood(state.sugg[state.sel]); return; }
      $("form").requestSubmit ? $("form").requestSubmit() : submit(ev);
    }
  });

  ["input", "change"].forEach(function (type) {
    $("f-time").addEventListener(type, function () { state.timeDirty = true; });
    $("fast-at").addEventListener(type, function () { state.fastDirty = true; });
  });

  setInterval(function () {
    tickFast();
    if (!state.fastDirty) resetFastInputs();
    if (!state.timeDirty && state.editing === null) {
      $("f-time").value = nowHHMM();
      updateMoreSummary();
    }
  }, TICK_MS);

  $("f-date").value = state.iso;
  $("f-time").value = nowHHMM();
  updateMoreSummary();
  resetFastInputs();
  loadFoods();
  load();
})();
