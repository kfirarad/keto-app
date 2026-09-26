(function () {
  "use strict";

  var TZ = "Europe/Copenhagen";
  var $ = function (id) { return document.getElementById(id); };

  var state = { iso: todayIso(), seq: 0 };

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

  function shiftIso(iso, days) {
    var p = iso.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.toISOString().slice(0, 10);
  }

  // ---- formatting --------------------------------------------------------

  function fmt(x) {
    if (x === null || x === undefined) return "–";
    return String(Math.round(x * 10) / 10);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // ---- render ------------------------------------------------------------

  function renderDay(day) {
    var t = day.totals;
    var net = t.net_carbs_g || 0;
    var over = day.over_goal;

    $("date").textContent = day.date;
    $("today").disabled = state.iso === todayIso();
    document.body.classList.toggle("over", over);

    $("net").textContent = fmt(net);
    $("goal").textContent = day.goal;
    $("bar").style.width = Math.min(100, (net / day.goal) * 100) + "%";
    $("status").textContent = over
      ? fmt(net - day.goal) + " g over goal"
      : fmt(day.remaining) + " g remaining";

    var sec = $("secondary");
    if (day.count === 0) {
      sec.hidden = true;
      sec.textContent = "";
    } else {
      var bits = [fmt(t.calories) + " kcal", fmt(t.fat_g) + " g fat", fmt(t.protein_g) + " g protein"];
      if (t.fasting_hours !== null) bits.push(fmt(t.fasting_hours) + " h fasting");
      sec.textContent = bits.join(" · ");
      sec.hidden = false;
    }

    renderEntries(day.entries);
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
      var h = el("h2", "meal", key || "No meal");
      h.dir = "auto";
      box.appendChild(h);
      box.appendChild(renderList(groups[key]));
    });
  }

  function renderList(entries) {
    var ol = el("ol");
    entries.forEach(function (e) { ol.appendChild(renderRow(e)); });
    return ol;
  }

  function renderRow(e) {
    var li = el("li", "row");
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

    var nums = [fmt(e.calories) + " kcal", fmt(e.fat_g) + " g fat", fmt(e.protein_g) + " g protein"];
    if (e.fasting_hours !== null) nums.push(fmt(e.fasting_hours) + " h fast");
    body.appendChild(el("p", "nums", nums.join(" · ")));

    if (e.notes) {
      var n = el("p", "notes", e.notes);
      n.dir = "auto";
      body.appendChild(n);
    }
    li.appendChild(body);
    li.appendChild(el("span", "carbs", fmt(e.net_carbs_g) + " g"));
    return li;
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

  function load() {
    var seq = ++state.seq;
    $("date").textContent = isoToDmy(state.iso);
    return api("/api/day?date=" + encodeURIComponent(isoToDmy(state.iso)))
      .then(function (day) { if (seq === state.seq) renderDay(day); })
      .catch(function (err) { if (seq === state.seq) showError(err.message); });
  }

  function go(iso) {
    state.iso = iso;
    showError("");
    load();
  }

  function showError(msg) { $("error").textContent = msg; }

  // ---- form --------------------------------------------------------------

  var TEXT = { item: "f-item", quantity: "f-quantity", meal: "f-meal", notes: "f-notes", time: "f-time" };
  var NUM = { net_carbs_g: "f-net", calories: "f-cal", fat_g: "f-fat", protein_g: "f-protein", fasting_hours: "f-fast" };

  function readForm() {
    var out = { date: isoToDmy(state.iso) };
    Object.keys(TEXT).forEach(function (k) {
      var v = $(TEXT[k]).value;
      if (v.trim() !== "") out[k] = v;
    });
    Object.keys(NUM).forEach(function (k) {
      var v = $(NUM[k]).value.trim().replace(",", ".");
      if (v !== "") out[k] = v;
    });
    return out;
  }

  function submit(ev) {
    ev.preventDefault();
    var entry = readForm();
    if (!entry.item) { showError("Item is required."); $("f-item").focus(); return; }
    if (entry.net_carbs_g === undefined || !isFinite(Number(entry.net_carbs_g))) {
      showError("Net carbs is required and must be a number."); $("f-net").focus(); return;
    }
    Object.keys(NUM).forEach(function (k) {
      if (entry[k] !== undefined && isFinite(Number(entry[k]))) entry[k] = Number(entry[k]);
    });
    showError("");
    $("save").disabled = true;
    api("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry)
    }).then(function () {
      $("f-item").value = "";
      $("f-quantity").value = "";
      $("f-notes").value = "";
      $("f-item").focus();
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
  $("f-item").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      $("form").requestSubmit ? $("form").requestSubmit() : submit(ev);
    }
  });
  $("f-time").value = nowHHMM();

  load();
})();
