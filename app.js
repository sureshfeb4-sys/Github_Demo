/* ==========================================================
   VoiceNotes — local-only voice todo app
   Storage: localStorage (never leaves the device)
   Voice:   Web Speech API (SpeechRecognition + speechSynthesis)
   Reminders: Google Calendar "event template" link + in-app alerts
   ========================================================== */
(() => {
  "use strict";

  /* ---------------- Utilities ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const ACCENTS = ["#a8e6cf", "#ffe58f", "#ffadad"];

  /* ---------------- Store (localStorage) ---------------- */
  const STORAGE_KEY = "voicenotes.v1";
  const Store = {
    state: { notes: [] },
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.notes)) this.state = parsed;
        } else {
          this.seed();
        }
      } catch (e) {
        console.warn("Could not read storage", e);
      }
    },
    save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
      catch (e) { toast("Storage is full or blocked"); }
    },
    snapshot() { return JSON.stringify(this.state); },
    restore(snap) { this.state = JSON.parse(snap); this.save(); },
    seed() {
      const n = this.createNote("Getting started", false);
      ["Tap the yellow mic and say “Add milk to Groceries”",
       "Say “Mark milk as done”",
       "Say “Remind me to call mom tomorrow at 6 pm”",
       "Tap a circle to tick an item"].forEach((t) => this.addItem(n.id, t, false));
      const g = this.createNote("Groceries", false);
      ["Milk", "Eggs", "Bread", "Bananas"].forEach((t) => this.addItem(g.id, t, false));
      g.items[1].done = true;
      this.save();
    },
    get notes() { return this.state.notes; },
    getNote(id) { return this.state.notes.find((n) => n.id === id) || null; },
    touch(note) { note.updatedAt = Date.now(); },
    createNote(title, persist = true) {
      const note = {
        id: uid(),
        title: cap((title || "").trim()) || "Untitled note",
        color: ACCENTS[this.state.notes.length % ACCENTS.length],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reminder: null,
        items: [],
      };
      this.state.notes.unshift(note);
      if (persist) this.save();
      return note;
    },
    renameNote(id, title) {
      const n = this.getNote(id); if (!n) return;
      n.title = title.trim() || "Untitled note"; this.touch(n); this.save();
    },
    deleteNote(id) {
      this.state.notes = this.state.notes.filter((n) => n.id !== id); this.save();
    },
    addItem(noteId, text, persist = true) {
      const n = this.getNote(noteId); if (!n) return null;
      const item = { id: uid(), text: cap(text.trim()), done: false, createdAt: Date.now(), reminder: null };
      n.items.push(item); this.touch(n);
      if (persist) this.save();
      return item;
    },
    updateItem(noteId, itemId, patch) {
      const n = this.getNote(noteId); if (!n) return null;
      const it = n.items.find((i) => i.id === itemId); if (!it) return null;
      Object.assign(it, patch); this.touch(n); this.save();
      return it;
    },
    deleteItem(noteId, itemId) {
      const n = this.getNote(noteId); if (!n) return;
      n.items = n.items.filter((i) => i.id !== itemId); this.touch(n); this.save();
    },
    clearCompleted(noteId) {
      const n = this.getNote(noteId); if (!n) return 0;
      const before = n.items.length;
      n.items = n.items.filter((i) => !i.done); this.touch(n); this.save();
      return before - n.items.length;
    },
  };

  /* ---------------- Fuzzy matching ---------------- */
  const clean = (s) => String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|a|an|my|our|this|that)\b/g, " ")
    .replace(/\s+/g, " ").trim();

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function similarity(query, target) {
    const a = clean(query), b = clean(target);
    if (!a || !b) return 0;
    if (a === b) return 1;
    let score = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    if (b.includes(a) || a.includes(b)) {
      score = Math.max(score, 0.7 + 0.25 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)));
    }
    const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
    const inter = [...ta].filter((t) => tb.has(t)).length;
    if (inter) score = Math.max(score, 0.55 + 0.4 * (inter / Math.max(ta.size, tb.size)));
    return score;
  }

  function bestMatch(query, list, getText, threshold = 0.62) {
    const scored = list.map((x) => ({ x, s: similarity(query, getText(x)) }))
      .filter((r) => r.s >= threshold)
      .sort((p, q) => q.s - p.s);
    return scored;
  }

  /* ---------------- Date / time parser ---------------- */
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, "forty five": 45 };

  function parseDateTime(input, now = new Date()) {
    let text = " " + input.toLowerCase()
      .replace(/\b(a|p)\.\s?m\.?/g, "$1m")
      .replace(/\b(forty five|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\b/g, (w) => NUMWORDS[w])
      .replace(/\s+/g, " ") + " ";
    let day = null;        // Date (midnight) for the chosen day
    let time = null;       // {h, m}
    let relative = null;   // Date from "in N minutes"
    const strip = (re) => { text = text.replace(re, " "); };

    // "in 10 minutes", "in an hour", "in half an hour", "in 2 days"
    let m = text.match(/\bin\s+(half an?|an?|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/);
    if (m) {
      let qty = m[1].startsWith("half") ? 0.5 : /^an?$/.test(m[1]) ? 1 : parseFloat(m[1]);
      const unit = m[2];
      const ms = /^min/.test(unit) ? 60e3 : /^(hour|hr)/.test(unit) ? 3600e3 : /^day/.test(unit) ? 864e5 : 6048e5;
      relative = new Date(now.getTime() + qty * ms);
      strip(m[0]);
    }

    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = midnight(now);
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

    if ((m = text.match(/\b(on\s+)?(the\s+)?day after tomorrow\b/))) { day = addDays(today, 2); strip(m[0]); }
    else if ((m = text.match(/\b(on\s+)?tomorrow\b/))) { day = addDays(today, 1); strip(m[0]); }
    else if ((m = text.match(/\btonight\b/))) { day = today; time = time || { h: 20, m: 0 }; strip(m[0]); }
    else if ((m = text.match(/\b(for\s+)?today\b/))) { day = today; strip(m[0]); }

    // weekday: "on friday", "next monday", "this saturday"
    if (!day && (m = text.match(/\b(?:on\s+)?(next\s+|this\s+|coming\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
      const target = WEEKDAYS.indexOf(m[2]);
      let diff = (target - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      day = addDays(today, diff);
      strip(m[0]);
    }

    // "25 december", "25th of december", "december 25", "dec 25th"
    const monRe = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const monIdx = (s) => MONTHS.findIndex((mm) => mm.startsWith(s.slice(0, 3)));
    if (!day && (m = text.match(new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monRe}\\b`)))) {
      day = new Date(now.getFullYear(), monIdx(m[2]), parseInt(m[1], 10)); strip(m[0]);
    } else if (!day && (m = text.match(new RegExp(`\\b(?:on\\s+)?${monRe}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
      day = new Date(now.getFullYear(), monIdx(m[1]), parseInt(m[2], 10)); strip(m[0]);
    } else if (!day && (m = text.match(/\b(?:on\s+)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/))) {
      // dd/mm[/yyyy] (day-first, as used in most of the world)
      let y = m[3] ? parseInt(m[3], 10) : now.getFullYear();
      if (y < 100) y += 2000;
      day = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10)); strip(m[0]);
    }
    if (day && day < today && !/\d{4}/.test(input)) day = new Date(day.getFullYear() + 1, day.getMonth(), day.getDate());

    // time of day words
    if ((m = text.match(/\b(at\s+)?noon\b/))) { time = { h: 12, m: 0 }; strip(m[0]); }
    else if ((m = text.match(/\b(at\s+)?midnight\b/))) { time = { h: 23, m: 59 }; strip(m[0]); }

    // explicit time: "at 5 pm", "5:30pm", "at 17:00", "at 7"
    if ((m = text.match(/\b(?:at\s+|by\s+|around\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/))) {
      let h = parseInt(m[1], 10) % 12; if (m[3] === "pm") h += 12;
      time = { h, m: m[2] ? parseInt(m[2], 10) : 0 }; strip(m[0]);
    } else if ((m = text.match(/\b(?:at\s+|by\s+|around\s+)(\d{1,2})(?:[:.](\d{2}))?\b/)) || (m = text.match(/\b(\d{1,2})[:](\d{2})\b/))) {
      let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0;
      if (h <= 7 && !m[2]) h += 12; // "at 5" most likely means 5 pm
      if (h < 24 && mi < 60) { time = { h, m: mi }; strip(m[0]); }
    }

    // part-of-day fallbacks
    if (!time) {
      if ((m = text.match(/\b(this\s+|in the\s+)?morning\b/))) { time = { h: 9, m: 0 }; strip(m[0]); }
      else if ((m = text.match(/\b(this\s+|in the\s+)?afternoon\b/))) { time = { h: 15, m: 0 }; strip(m[0]); }
      else if ((m = text.match(/\b(this\s+|in the\s+)?evening\b/))) { time = { h: 18, m: 0 }; strip(m[0]); }
      else if ((m = text.match(/\b(at\s+)?night\b/))) { time = { h: 20, m: 0 }; strip(m[0]); }
    }

    let date = null;
    if (relative) date = relative;
    else if (day || time) {
      const t = time || { h: 9, m: 0 };
      const base = day || today;
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.h, t.m, 0, 0);
      if (!day && date <= now) date.setDate(date.getDate() + 1); // time already passed today → tomorrow
    }
    const rest = text.replace(/\s+(on|at|for|by)\s*$/, " ").replace(/\s+/g, " ").trim();
    return { date, rest };
  }

  /* ---------------- Google Calendar link ---------------- */
  function toGCalStamp(d) {
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  function googleCalendarUrl(title, start, details = "", minutes = 30) {
    const end = new Date(start.getTime() + minutes * 60e3);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: `${toGCalStamp(start)}/${toGCalStamp(end)}`,
      details: details || "Reminder from VoiceNotes",
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function fmtWhen(d) {
    const now = new Date();
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (sameDay(d, now)) return `today at ${time}`;
    if (sameDay(d, tmr)) return `tomorrow at ${time}`;
    return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
  }
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
  }

  /* ---------------- Local reminder alerts ---------------- */
  const timers = new Map();
  function scheduleReminders() {
    timers.forEach(clearTimeout); timers.clear();
    const now = Date.now();
    Store.notes.forEach((n) => {
      const list = n.items.filter((i) => i.reminder && !i.done).map((i) => ({ key: i.id, text: i.text, at: i.reminder, note: n.title }));
      if (n.reminder) list.push({ key: n.id, text: n.title, at: n.reminder, note: n.title });
      list.forEach((r) => {
        const delay = new Date(r.at).getTime() - now;
        if (delay > 0 && delay < 2147483647) {
          timers.set(r.key, setTimeout(() => fireReminder(r), delay));
        }
      });
    });
  }
  function fireReminder(r) {
    const msg = `Reminder: ${r.text}`;
    toast(`⏰ ${msg}`);
    speak(msg);
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("VoiceNotes", { body: `${r.text} · ${r.note}` }); } catch (_) { /* some mobile browsers need a service worker */ }
    }
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
  function askNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (_) { /* ignore */ }
    }
  }

  /* ---------------- Toast with undo ---------------- */
  let toastTimer = null;
  function toast(text, actionLabel, onAction) {
    const el = $("#toast"), btn = $("#toast-action");
    $("#toast-text").textContent = text;
    el.hidden = false;
    if (onAction) {
      btn.hidden = false; btn.textContent = actionLabel || "Undo";
      btn.onclick = () => { onAction(); el.hidden = true; };
    } else { btn.hidden = true; btn.onclick = null; }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, onAction ? 5000 : 3000);
  }
  function undoable(message, mutate) {
    const snap = Store.snapshot();
    mutate();
    render(); scheduleReminders();
    toast(message, "Undo", () => { Store.restore(snap); render(); scheduleReminders(); });
  }

  /* ---------------- Router ---------------- */
  const route = { name: "home", noteId: null };
  function parseRoute() {
    const m = location.hash.match(/^#note-([A-Za-z0-9]+)/);
    if (m && Store.getNote(m[1])) { route.name = "note"; route.noteId = m[1]; }
    else { route.name = "home"; route.noteId = null; }
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else { parseRoute(); render(); } }
  window.addEventListener("hashchange", () => { parseRoute(); render(); window.scrollTo(0, 0); });

  /* ---------------- Rendering ---------------- */
  function render() {
    parseRoute();
    $("#screen-home").hidden = route.name !== "home";
    $("#screen-note").hidden = route.name !== "note";
    if (route.name === "home") renderHome(); else renderNote();
  }

  function renderHome() {
    const h = new Date().getHours();
    $("#greeting").textContent = h < 12 ? "Good morning ☀️" : h < 17 ? "Good afternoon 🌤️" : "Good evening 🌙";
    const q = clean($("#search-input").value);
    const notes = [...Store.notes].sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((n) => !q || clean(n.title).includes(q) || n.items.some((i) => clean(i.text).includes(q)));
    const open = Store.notes.reduce((s, n) => s + n.items.filter((i) => !i.done).length, 0);
    $("#home-stats").textContent = `${open} open`;

    const grid = $("#notes-grid");
    grid.innerHTML = notes.map((n, idx) => {
      const done = n.items.filter((i) => i.done).length;
      const total = n.items.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const preview = [...n.items].sort((a, b) => a.done - b.done).slice(0, 3)
        .map((i) => `<li class="${i.done ? "done" : ""}">${esc(i.text)}</li>`).join("");
      const hasRem = n.reminder || n.items.some((i) => i.reminder && !i.done && new Date(i.reminder) > new Date());
      return `
        <div class="note-card" role="button" tabindex="0" data-id="${n.id}" style="--accent:${n.color}; animation-delay:${idx * 40}ms" aria-label="${esc(n.title)}, ${done} of ${total} done">
          ${hasRem ? `<svg class="bell-dot"><use href="#i-bell"/></svg>` : ""}
          <h3>${esc(n.title)}</h3>
          <ul class="preview">${preview || `<li style="list-style:none">No items yet</li>`}</ul>
          <div class="mini-progress"><div style="width:${pct}%"></div></div>
          <div class="meta"><span class="count">${done}/${total}</span><span>${timeAgo(n.updatedAt)}</span></div>
        </div>`;
    }).join("");
    $("#home-empty").hidden = Store.notes.length > 0;
    if (Store.notes.length && !notes.length) {
      grid.innerHTML = `<p class="eyebrow" style="grid-column:1/-1;text-align:center;padding:20px">No matches</p>`;
    }
  }

  function renderNote() {
    const n = Store.getNote(route.noteId);
    if (!n) return go("#home");
    state.lastNoteId = n.id;
    const titleEl = $("#note-title");
    if (document.activeElement !== titleEl) titleEl.value = n.title;
    document.documentElement.style.setProperty("--accent", n.color);
    const done = n.items.filter((i) => i.done).length;
    $("#note-meta").textContent = `${done} of ${n.items.length} done` + (n.reminder ? ` · ⏰ ${fmtWhen(new Date(n.reminder))}` : "");
    $("#note-progress").style.width = n.items.length ? `${(done / n.items.length) * 100}%` : "0";
    const now = new Date();
    $("#items-list").innerHTML = n.items.map((i) => {
      const rem = i.reminder ? new Date(i.reminder) : null;
      return `
      <li class="item ${i.done ? "done" : ""}" data-id="${i.id}">
        <button class="check" data-act="toggle" aria-label="${i.done ? "Mark as not done" : "Mark as done"}"><svg class="icon"><use href="#i-check"/></svg></button>
        <div class="item-body">
          <span class="item-text" contenteditable="true" spellcheck="false" data-act="edit">${esc(i.text)}</span>
          ${rem ? `<span class="rem-chip ${rem < now ? "past" : ""}"><svg class="icon"><use href="#i-bell"/></svg>${fmtWhen(rem)}</span>` : ""}
        </div>
        <button class="item-btn bell" data-act="remind" aria-label="Set reminder"><svg class="icon"><use href="#i-bell"/></svg></button>
        <button class="item-btn del" data-act="delete" aria-label="Delete item"><svg class="icon"><use href="#i-trash"/></svg></button>
      </li>`;
    }).join("");
    $("#note-empty").hidden = n.items.length > 0;
    $("#btn-clear-done").hidden = done === 0;
  }

  function flashItem(itemId) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.item[data-id="${itemId}"]`);
      if (el) { el.classList.add("flash"); el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    });
  }

  /* ---------------- UI events: home ---------------- */
  $("#search-input").addEventListener("input", renderHome);
  $("#fab-new").addEventListener("click", () => {
    const n = Store.createNote("");
    go(`#note-${n.id}`);
    setTimeout(() => { const t = $("#note-title"); t.focus(); t.select(); }, 60);
  });

  // tap = open, long-press = delete
  let pressTimer = null, longPressed = false;
  const grid = $("#notes-grid");
  grid.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".note-card"); if (!card) return;
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(30);
      const n = Store.getNote(card.dataset.id);
      if (n) undoable(`Deleted “${n.title}”`, () => Store.deleteNote(n.id));
    }, 550);
  });
  ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((ev) =>
    grid.addEventListener(ev, (e) => { if (ev !== "pointermove" || Math.abs(e.movementY) > 3) clearTimeout(pressTimer); }));
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".note-card"); if (!card || longPressed) return;
    go(`#note-${card.dataset.id}`);
  });
  grid.addEventListener("keydown", (e) => {
    const card = e.target.closest(".note-card");
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(`#note-${card.dataset.id}`); }
  });
  grid.addEventListener("contextmenu", (e) => { if (e.target.closest(".note-card")) e.preventDefault(); });

  /* ---------------- UI events: note ---------------- */
  $("#btn-back").addEventListener("click", () => go("#home"));
  $("#note-title").addEventListener("input", (e) => {
    const n = Store.getNote(route.noteId); if (!n) return;
    n.title = e.target.value; Store.touch(n); Store.save();
  });
  $("#note-title").addEventListener("blur", (e) => { Store.renameNote(route.noteId, e.target.value); renderNote(); });
  $("#note-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });

  $("#btn-delete-note").addEventListener("click", () => {
    const n = Store.getNote(route.noteId); if (!n) return;
    go("#home");
    undoable(`Deleted “${n.title}”`, () => Store.deleteNote(n.id));
  });

  $("#add-item-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#add-item-input");
    const text = input.value.trim(); if (!text) return;
    const it = Store.addItem(route.noteId, text);
    input.value = ""; renderNote(); flashItem(it.id);
  });

  $("#items-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]"); if (!btn) return;
    const li = btn.closest(".item"); const itemId = li.dataset.id;
    const n = Store.getNote(route.noteId);
    const it = n && n.items.find((i) => i.id === itemId); if (!it) return;
    const act = btn.dataset.act;
    if (act === "toggle") { Store.updateItem(n.id, itemId, { done: !it.done }); renderNote(); scheduleReminders(); }
    else if (act === "delete") {
      li.classList.add("removing");
      setTimeout(() => undoable(`Deleted “${it.text}”`, () => Store.deleteItem(n.id, itemId)), 200);
    } else if (act === "remind") openReminderSheet(n.id, itemId);
  });
  $("#items-list").addEventListener("keydown", (e) => {
    if (e.target.dataset.act === "edit" && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });
  $("#items-list").addEventListener("focusout", (e) => {
    if (e.target.dataset.act !== "edit") return;
    const itemId = e.target.closest(".item").dataset.id;
    const text = e.target.textContent.trim();
    if (text) Store.updateItem(route.noteId, itemId, { text }); else Store.deleteItem(route.noteId, itemId);
    renderNote();
  });

  $("#btn-clear-done").addEventListener("click", () => {
    const n = Store.getNote(route.noteId); if (!n) return;
    undoable("Cleared completed items", () => Store.clearCompleted(n.id));
  });

  /* ---------------- Sheets ---------------- */
  function openSheet(id) { $(`#${id}-sheet`).hidden = false; $(`#${id}-backdrop`).hidden = false; document.body.classList.add("sheet-open"); }
  function closeSheet(id) { $(`#${id}-sheet`).hidden = true; $(`#${id}-backdrop`).hidden = true; if ($("#voice-sheet").hidden && $("#rem-sheet").hidden) document.body.classList.remove("sheet-open"); }

  // Reminder sheet
  let remTarget = null;
  const toLocalInput = (d) => {
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  function openReminderSheet(noteId, itemId) {
    const n = Store.getNote(noteId); const it = n.items.find((i) => i.id === itemId);
    remTarget = { noteId, itemId };
    $("#rem-item-text").textContent = `“${it.text}” · ${n.title}`;
    const def = it.reminder ? new Date(it.reminder) : new Date(Date.now() + 3600e3);
    if (!it.reminder) def.setMinutes(0, 0, 0);
    $("#rem-datetime").value = toLocalInput(def);
    $("#rem-remove").hidden = !it.reminder;
    openSheet("rem");
  }
  $("#quick-times").addEventListener("click", (e) => {
    const q = e.target.dataset.quick; if (!q) return;
    const d = new Date();
    if (q === "1h") d.setTime(d.getTime() + 3600e3);
    if (q === "tonight") { d.setHours(20, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); }
    if (q === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    $("#rem-datetime").value = toLocalInput(d);
  });
  // The save button is a real link: we fill in its href during the click so the
  // browser opens Google Calendar natively (window.open is often blocked).
  $("#rem-save").addEventListener("click", (e) => {
    if (!remTarget) return e.preventDefault();
    const val = $("#rem-datetime").value; if (!val) { e.preventDefault(); return toast("Pick a date and time"); }
    const when = new Date(val);
    const n = Store.getNote(remTarget.noteId);
    const it = Store.updateItem(remTarget.noteId, remTarget.itemId, { reminder: when.toISOString() });
    closeSheet("rem"); renderNote(); scheduleReminders();
    askNotificationPermission();
    e.currentTarget.href = googleCalendarUrl(it.text, when, `From your “${n.title}” note in VoiceNotes`);
    toast(`Reminder set for ${fmtWhen(when)}`);
  });
  $("#rem-remove").addEventListener("click", () => {
    if (!remTarget) return;
    Store.updateItem(remTarget.noteId, remTarget.itemId, { reminder: null });
    closeSheet("rem"); renderNote(); scheduleReminders(); toast("Reminder removed");
  });
  $("#rem-close").addEventListener("click", () => closeSheet("rem"));
  $("#rem-backdrop").addEventListener("click", () => closeSheet("rem"));

  /* ==========================================================
     VOICE ASSISTANT
     ========================================================== */
  const state = { lastNoteId: null, pending: null, spokenInput: false };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false, interimBubble = null;

  const SUGGESTIONS = [
    "Create a note called Groceries",
    "Add milk, eggs and bread to Groceries",
    "Mark milk as done",
    "Delete bread from Groceries",
    "Remind me to pay rent tomorrow at 10 am",
    "What's in Groceries?",
    "Help",
  ];

  function openAssistant(startListening) {
    openSheet("voice");
    if (!$("#chat").children.length) {
      botSay(SR
        ? "Hi! Tap the mic and tell me what to do — add notes, add or delete items, tick things off, or set reminders."
        : "Hi! Voice input isn't supported in this browser, but you can type commands below.", { silent: true });
    }
    $("#suggestions").innerHTML = SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join("");
    if (startListening) startRecognition();
  }
  function closeAssistant() { stopRecognition(); closeSheet("voice"); if ("speechSynthesis" in window) speechSynthesis.cancel(); }

  $("#mic-home").addEventListener("click", () => openAssistant(true));
  $("#mic-note").addEventListener("click", () => openAssistant(true));
  $("#mic-sheet").addEventListener("click", () => (listening ? stopRecognition() : startRecognition()));
  $("#voice-close").addEventListener("click", closeAssistant);
  $("#voice-backdrop").addEventListener("click", closeAssistant);
  $("#suggestions").addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") { state.spokenInput = false; userSay(e.target.textContent); handleCommand(e.target.textContent); }
  });
  $("#voice-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#voice-text"); const text = input.value.trim(); if (!text) return;
    input.value = ""; state.spokenInput = false; userSay(text); handleCommand(text);
  });
  $("#chat").addEventListener("click", (e) => {
    const b = e.target.closest("[data-choice]"); if (!b || !state.pending) return;
    const p = state.pending; state.pending = null;
    b.parentElement.remove();
    userSay(b.textContent);
    p.resume(b.dataset.choice);
  });

  function setMicUI(on) {
    listening = on;
    document.querySelectorAll(".mic-btn").forEach((b) => b.classList.toggle("listening", on));
    $("#voice-text").placeholder = on ? "Listening…" : "Type or tap the mic…";
  }
  function startRecognition() {
    if (!SR) { botSay("Voice input isn't available in this browser. Try Chrome on Android, or type your command.", { error: true }); $("#voice-text").focus(); return; }
    if (listening) return;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    recognition = new SR();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setMicUI(true);
    recognition.onresult = (e) => {
      let finalText = "", interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      if (interim) {
        if (!interimBubble) interimBubble = addBubble("", "user interim");
        interimBubble.textContent = interim;
        scrollChat();
      }
      if (finalText) {
        if (interimBubble) { interimBubble.remove(); interimBubble = null; }
        state.spokenInput = true;
        userSay(finalText.trim());
        handleCommand(finalText.trim());
      }
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        botSay("I can't access the microphone. Allow mic permission, and make sure the app is opened over https:// (not as a local file).", { error: true });
      } else if (e.error === "no-speech") {
        botSay("I didn't hear anything. Tap the mic and try again.", { silent: true });
      } else if (e.error === "network") {
        botSay("Speech recognition needs an internet connection in this browser. You can still type commands.", { error: true });
      } else if (e.error !== "aborted") {
        botSay(`Voice error: ${e.error}`, { error: true });
      }
    };
    recognition.onend = () => {
      setMicUI(false);
      if (interimBubble) { interimBubble.remove(); interimBubble = null; }
    };
    try { recognition.start(); } catch (_) { /* already started */ }
  }
  function stopRecognition() { if (recognition) try { recognition.stop(); } catch (_) {} setMicUI(false); }

  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/[“”"]/g, ""));
      u.lang = navigator.language || "en-US"; u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (_) { /* ignore */ }
  }

  function addBubble(html, cls) {
    const b = document.createElement("div");
    b.className = `bubble ${cls}`; b.innerHTML = html;
    $("#chat").appendChild(b); scrollChat();
    return b;
  }
  const scrollChat = () => { const c = $("#chat"); c.scrollTop = c.scrollHeight; };
  function userSay(text) { addBubble(esc(text), "user"); }
  function botSay(text, opts = {}) {
    let html = esc(text);
    if (opts.link) html += `<br><a class="cal-link" href="${esc(opts.link)}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-cal"/></svg>Add to Google Calendar</a>`;
    if (opts.choices) html += `<div class="choice-row">${opts.choices.map((c) => `<button type="button" data-choice="${esc(c.value)}">${esc(c.label)}</button>`).join("")}</div>`;
    addBubble(html, `bot${opts.error ? " error" : ""}`);
    if (state.spokenInput && !opts.silent) speak(opts.speech || text);
  }

  /* ---------------- Intent handling ---------------- */
  function contextNote() {
    if (route.name === "note") return Store.getNote(route.noteId);
    if (state.lastNoteId && Store.getNote(state.lastNoteId)) return Store.getNote(state.lastNoteId);
    if (Store.notes.length === 1) return Store.notes[0];
    return null;
  }
  function findNote(name, threshold = 0.62) {
    const q = String(name || "").replace(/\s+(note|list)$/, "").trim();
    if (!q || /^(it|this|that|here|current|this one)$/.test(q)) return null;
    const r = bestMatch(q, Store.notes, (n) => n.title, threshold);
    return r.length ? r[0].x : null;
  }
  function findItem(note, query) {
    const r = bestMatch(query, note.items, (i) => i.text, 0.6);
    return r.length ? r[0].x : null;
  }
  function findItemAnywhere(query, preferNote) {
    if (preferNote) { const it = findItem(preferNote, query); if (it) return { note: preferNote, item: it }; }
    let best = null;
    Store.notes.forEach((n) => n.items.forEach((i) => {
      const s = similarity(query, i.text);
      if (s >= 0.6 && (!best || s > best.s)) best = { note: n, item: i, s };
    }));
    return best;
  }
  // Ask the user which note to use, then continue
  function withNote(explicitName, then, question = "Which note?") {
    if (explicitName && /^(it|this|that|here|list|note|notes|this note|this list|current)$/.test(explicitName)) explicitName = null;
    if (explicitName) {
      const n = findNote(explicitName);
      if (n) return then(n);
      return botSay(`I couldn't find a note called “${explicitName}”. Want me to create it?`, {
        choices: [{ label: `Create “${cap(explicitName)}”`, value: "__create__" }, { label: "Cancel", value: "__cancel__" }],
      }), (state.pending = {
        resume: (v) => {
          if (v === "__create__" || /^(yes|yeah|yep|sure|ok|okay|create)/.test(v)) { const n = Store.createNote(explicitName); render(); then(n); }
          else botSay("Okay, cancelled.");
        },
      });
    }
    const ctx = contextNote();
    if (ctx) return then(ctx);
    if (!Store.notes.length) { const n = Store.createNote("My list"); render(); return then(n); }
    state.pending = {
      resume: (v) => {
        const n = Store.getNote(v) || findNote(v);
        if (n) then(n); else botSay("Sorry, I couldn't find that note.");
      },
    };
    botSay(question, { choices: Store.notes.slice(0, 6).map((n) => ({ label: n.title, value: n.id })) });
  }
  function splitItems(s) {
    const parts = s.includes(",") ? s.split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=[^,]*$)/) : s.split(/\s+and\s+/);
    return parts.map((p) => p.replace(/^(also|then)\s+/, "").trim()).filter(Boolean);
  }
  const listWords = (arr) => arr.length <= 1 ? (arr[0] || "") : `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`;
  // Split "X to/in/from Groceries" into {body, noteName}, only if the tail really names a note
  function splitTarget(body, preps, loose = false) {
    const re = new RegExp(`^(.+)\\s+(?:${preps})\\s+(?:the\\s+|my\\s+)?(.+?)(?:\\s+(?:note|list))?$`);
    const m = body.match(re);
    if (m) {
      const tail = m[2];
      if (/^(it|this|that|here|list|note|this note|this list|current)$/.test(tail)) return { body: m[1], noteName: null };
      if (findNote(tail)) return { body: m[1], noteName: tail, found: true };
      if (loose || /\s+(note|list)$/.test(body)) return { body: m[1], noteName: tail, found: false, whole: body };
    }
    return { body, noteName: null };
  }
  function showNote(note, itemId) {
    state.lastNoteId = note.id;
    if (route.name === "note" && route.noteId === note.id) renderNote();
    else if (route.name === "note") go(`#note-${note.id}`);
    else renderHome();
    if (itemId) flashItem(itemId);
  }

  function handleCommand(raw) {
    const text = raw.toLowerCase()
      .replace(/\b(a|p)\.\s?m\.?/g, "$1m")
      .replace(/[.!?]+$/g, "")
      .replace(/^(hey|ok|okay)\s+(assistant|app|notes)[,\s]*/, "")
      .replace(/^(please|can you|could you|would you|i want to|i'd like to|i need to)\s+/, "")
      .replace(/^(please)\s+/, "")
      .replace(/\s+please$/, "")
      .replace(/\s+/g, " ").trim();
    if (!text) return;

    // Pending follow-up question (e.g. "Which note?" / "When?")
    if (state.pending) {
      const p = state.pending;
      if (!/^(cancel|never ?mind|stop)$/.test(text)) {
        state.pending = null;
        document.querySelectorAll("#chat .choice-row").forEach((r) => r.remove());
        return p.resume(text);
      }
      state.pending = null;
      return botSay("Okay, cancelled.");
    }

    let m;

    // HELP
    if (/^(help|what can you do|commands)\b/.test(text)) {
      return botSay("Try: “Create a note called Groceries”, “Add milk and eggs to Groceries”, “Mark milk as done”, “Uncheck milk”, “Delete eggs”, “Delete the Groceries note”, “Open Groceries”, “Clear completed”, or “Remind me to pay rent on Friday at 10 am”.",
        { speech: "You can create notes, add or delete items, mark items done, and set reminders. Try: add milk to groceries." });
    }

    // GO HOME
    if (/^(go (back|home)|home|show (all|my) notes|all notes|back)$/.test(text)) {
      go("#home"); return botSay("Here are all your notes.");
    }

    // REMINDER
    if (/\b(remind|reminder|alarm)\b/.test(text)) return handleReminder(text);

    // CREATE NOTE: "create a note called groceries (with milk and eggs)"
    if ((m = text.match(/^(?:create|make|start|add|new|open)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:note|list|todo list|to-do list|checklist)\b(?:\s+(?:called|named|titled|for|about))?\s*(.*)$/))) {
      let title = m[1].trim(), items = [];
      const w = title.match(/^(.*?)\s+(?:with|containing|having)\s+(?:items?\s+)?(.+)$/);
      if (w) { title = w[1]; items = splitItems(w[2]); }
      const existing = title && Store.notes.find((n) => clean(n.title) === clean(title));
      const note = existing || Store.createNote(title);
      items.forEach((t) => Store.addItem(note.id, t));
      state.lastNoteId = note.id;
      go(`#note-${note.id}`);
      return botSay(existing
        ? `You already have “${note.title}”, so I opened it${items.length ? ` and added ${listWords(items)}` : ""}.`
        : `Created “${note.title}”${items.length ? ` with ${listWords(items)}` : ""}.`);
    }

    // DELETE NOTE (explicit): "delete the groceries note" / "delete note groceries"
    if ((m = text.match(/^(?:delete|remove|erase|discard|trash)\s+(?:the\s+|my\s+)?(?:note|list)\s+(?:called\s+|named\s+)?(.+)$/)) ||
        (m = text.match(/^(?:delete|remove|erase|discard|trash)\s+(?:the\s+|my\s+)?(.+?)\s+(?:note|list)$/))) {
      const name = m[1];
      const note = /^(this|current|it)$/.test(name) ? contextNote() : findNote(name);
      if (!note) return botSay(`I couldn't find a note called “${name}”.`);
      return confirmDeleteNote(note);
    }
    if (/^(?:delete|remove)\s+(?:this|the current)\s+(?:note|list)$/.test(text)) {
      const note = contextNote(); if (!note) return botSay("Open a note first, or tell me its name.");
      return confirmDeleteNote(note);
    }

    // CLEAR COMPLETED
    if ((m = text.match(/^(?:clear|remove|delete)\s+(?:all\s+)?(?:the\s+)?(?:completed|done|finished|ticked|checked)(?:\s+items)?(?:\s+(?:from|in)\s+(?:the\s+)?(.+?))?$/))) {
      return withNote(m[1], (note) => {
        const snap = Store.snapshot();
        const count = Store.clearCompleted(note.id);
        showNote(note); scheduleReminders();
        toast(`Cleared ${count} item${count === 1 ? "" : "s"}`, "Undo", () => { Store.restore(snap); render(); });
        botSay(count ? `Cleared ${count} completed item${count === 1 ? "" : "s"} from “${note.title}”.` : `Nothing completed in “${note.title}” yet.`);
      });
    }

    // OPEN NOTE
    if ((m = text.match(/^(?:open|show|go to|view|switch to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:note|list))?$/))) {
      const note = findNote(m[1]);
      if (!note) return botSay(`I couldn't find a note called “${m[1]}”.`, { choices: [{ label: `Create “${cap(m[1])}”`, value: "__c" }] }),
        (state.pending = { resume: (v) => (v === "__c" || /^(yes|yeah|yep|sure|ok|okay|create)/.test(v)) ? handleCommand(`create a note called ${m[1]}`) : botSay("Okay.") });
      state.lastNoteId = note.id; go(`#note-${note.id}`);
      return botSay(`Opened “${note.title}”.`);
    }

    // READ NOTE
    if ((m = text.match(/^(?:read|read out|what(?:'s| is) (?:in|on)|what do i have (?:in|on)|list items (?:in|on))\s*(?:the\s+|my\s+)?(.*?)(?:\s+(?:note|list))?$/))) {
      return withNote(m[1] || null, (note) => {
        state.lastNoteId = note.id;
        const open = note.items.filter((i) => !i.done).map((i) => i.text);
        const done = note.items.length - open.length;
        botSay(open.length
          ? `“${note.title}” has ${open.length} open item${open.length === 1 ? "" : "s"}: ${listWords(open)}.${done ? ` ${done} done.` : ""}`
          : note.items.length ? `Everything in “${note.title}” is done! 🎉` : `“${note.title}” is empty.`);
      });
    }

    // UNCHECK ITEM
    if ((m = text.match(/^(?:uncheck|untick|unmark|reopen|undo)\s+(.+)$/)) ||
        (m = text.match(/^mark\s+(.+?)\s+as\s+(?:not done|undone|incomplete|pending|open|not complete(?:d)?)((?:\s+(?:in|on|from)\s+.+)?)$/))) {
      return toggleItemCmd(m[1] + (m[2] || ""), false);
    }

    // COMPLETE ITEM
    if ((m = text.match(/^(?:mark|tick|tick off|check|check off|complete|finish|finished|cross off|strike|done with|i (?:have )?(?:bought|did|finished|completed))\s+(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished|off))?$/)) ||
        (m = text.match(/^(.+?)\s+(?:is|are)\s+(?:done|completed|finished)$/))) {
      return toggleItemCmd(m[1], true);
    }

    // DELETE ITEM (or a note, if the name matches a note)
    if ((m = text.match(/^(?:delete|remove|erase|cross out|get rid of|take off)\s+(.+)$/))) {
      const { body, noteName } = splitTarget(m[1], "from|in|on|off");
      const names = splitItems(body);
      const target = noteName ? findNote(noteName) : contextNote();
      if (!noteName && names.length === 1) {
        const noteHit = findNote(names[0], 0.85);
        if (noteHit && !(target && findItem(target, names[0]))) return confirmDeleteNote(noteHit);
      }
      const found = names.map((nm) => ({ nm, hit: findItemAnywhere(nm, target) }));
      const hits = found.filter((f) => f.hit && (!target || f.hit.note.id === target.id || !noteName));
      if (!hits.length) {
        return botSay(`I couldn't find “${body}”${target ? ` in “${target.title}”` : ""}.`);
      }
      const snap = Store.snapshot();
      hits.forEach((h) => Store.deleteItem(h.hit.note.id, h.hit.item.id));
      const note = hits[0].hit.note;
      showNote(note); scheduleReminders();
      toast("Deleted", "Undo", () => { Store.restore(snap); render(); });
      const missing = found.filter((f) => !hits.includes(f)).map((f) => f.nm);
      return botSay(`Deleted ${listWords(hits.map((h) => `“${h.hit.item.text}”`))} from “${note.title}”.${missing.length ? ` Couldn't find ${listWords(missing)}.` : ""}`);
    }

    // ADD ITEMS: "add milk and eggs to groceries" / "add bread"
    if ((m = text.match(/^(?:add|put|include|append|insert|also add|write down|note down|buy)\s+(.+)$/))) {
      const tgt = splitTarget(m[1], "to|into|onto", true);
      const { body, noteName } = tgt.noteName ? tgt : splitTarget(m[1], "in|on|for");
      const items = splitItems(body.replace(/^(an item|item|items)\s+/, ""));
      if (!items.length) return botSay("What should I add?");
      const addTo = (note, list) => {
        const added = list.map((t) => Store.addItem(note.id, t));
        showNote(note, added[added.length - 1].id);
        botSay(`Added ${listWords(added.map((a) => `“${a.text}”`))} to “${note.title}”.`);
      };
      if (noteName && tgt.found === false) {
        // "add milk to groceries" but there's no Groceries note yet
        state.pending = {
          resume: (v) => {
            if (v === "__new__" || /^(yes|yeah|yep|sure|ok|okay|create)/.test(v)) { const n = Store.createNote(noteName); state.lastNoteId = n.id; render(); addTo(n, items); }
            else if (v === "__asis__") withNote(null, (n) => addTo(n, [tgt.whole]));
            else botSay("Okay, cancelled.");
          },
        };
        return botSay(`There's no “${cap(noteName)}” note yet. What should I do?`, {
          choices: [{ label: `Create “${cap(noteName)}” & add`, value: "__new__" }, { label: `Add “${cap(tgt.whole)}” as one item`, value: "__asis__" }],
        });
      }
      return withNote(noteName, (note) => addTo(note, items), `Which note should I add ${listWords(items)} to?`);
    }

    botSay("Sorry, I didn't get that. Say “help” to hear what I can do.", { speech: "Sorry, I didn't get that." });
  }

  function confirmDeleteNote(note) {
    const snap = Store.snapshot();
    const wasOpen = route.name === "note" && route.noteId === note.id;
    Store.deleteNote(note.id);
    if (state.lastNoteId === note.id) state.lastNoteId = null;
    if (wasOpen) go("#home"); else render();
    scheduleReminders();
    toast(`Deleted “${note.title}”`, "Undo", () => { Store.restore(snap); render(); scheduleReminders(); });
    botSay(`Deleted the “${note.title}” note. Tap Undo if that was a mistake.`, { speech: `Deleted ${note.title}.` });
  }

  function toggleItemCmd(rawBody, done) {
    let { body, noteName } = splitTarget(rawBody, "in|on|from");
    body = body.replace(/\s+(?:as\s+)?(?:done|complete|completed|finished|off|not done|undone|incomplete)$/, "");
    const names = splitItems(body);
    const target = noteName ? findNote(noteName) : contextNote();
    const results = names.map((nm) => ({ nm, hit: findItemAnywhere(nm, target) }));
    const hits = results.filter((r) => r.hit);
    if (!hits.length) return botSay(`I couldn't find “${body}”${target ? ` in “${target.title}”` : ""}.`);
    hits.forEach((h) => Store.updateItem(h.hit.note.id, h.hit.item.id, { done }));
    const note = hits[0].hit.note;
    showNote(note, hits[0].hit.item.id); scheduleReminders();
    const names2 = listWords(hits.map((h) => `“${h.hit.item.text}”`));
    const left = note.items.filter((i) => !i.done).length;
    botSay(done
      ? `Ticked off ${names2}. ${left ? `${left} left in “${note.title}”.` : `All done in “${note.title}”! 🎉`}`
      : `Marked ${names2} as not done.`);
  }

  function handleReminder(text) {
    const { date, rest } = parseDateTime(text);
    let subject = rest
      .replace(/^(?:set|create|add|make|schedule|put)?\s*(?:me\s+)?(?:a|an)?\s*(?:reminder|alarm)\s*(?:for|to|about|that|on)?\s*/, "")
      .replace(/^remind\s+(?:me\s+)?(?:to|about|of|that)?\s*/, "")
      .replace(/^(?:me\s+)?(?:to|about|for)\s+/, "")
      .replace(/\s+(?:on|at|for|by)$/, "")
      .trim();
    // optional note target: "... in groceries" / "... from the groceries list"
    let noteName = null;
    const t = subject.match(/^(.+?)\s+(?:in|from|on)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:note|list))?$/);
    if (t && findNote(t[2])) { subject = t[1]; noteName = t[2]; }

    const proceed = (when) => {
      if (when <= new Date()) return botSay("That time has already passed. When should I remind you?"), (state.pending = { resume: (v) => askWhen(v) });
      const ctx = noteName ? findNote(noteName) : contextNote();
      let note, item = null, label;
      // A note name wins ("remind me about groceries"); otherwise only a close item match counts,
      // so "remind me to call mom" creates a new item instead of hijacking a loosely similar one.
      const noteHit = subject ? findNote(subject, 0.85) : null;
      let hit = null;
      if (subject && !noteHit) {
        const pool = noteName ? [ctx] : Store.notes;
        pool.forEach((n) => n.items.forEach((i) => {
          const s = similarity(subject, i.text);
          if (s >= 0.8 && (!hit || s > hit.s)) hit = { note: n, item: i, s };
        }));
      }
      if (hit) {
        note = hit.note; item = hit.item;
        Store.updateItem(note.id, item.id, { reminder: when.toISOString() });
        label = item.text;
      } else if (noteHit) {
        note = noteHit; note.reminder = when.toISOString(); Store.touch(note); Store.save();
        label = note.title;
      } else if (!subject && ctx) {
        note = ctx; note.reminder = when.toISOString(); Store.touch(note); Store.save();
        label = note.title;
      } else {
        note = ctx || Store.notes.find((n) => clean(n.title) === "reminders") || Store.createNote("Reminders");
        item = Store.addItem(note.id, subject || "Reminder");
        Store.updateItem(note.id, item.id, { reminder: when.toISOString() });
        label = item.text;
      }
      showNote(note, item && item.id); scheduleReminders();
      askNotificationPermission();
      const url = googleCalendarUrl(label, when, `From your “${note.title}” note in VoiceNotes`);
      botSay(`Reminder set: “${label}” ${fmtWhen(when)}. Tap below to save it in Google Calendar.`, {
        link: url,
        speech: `Okay, I'll remind you to ${label} ${fmtWhen(when)}. Tap the button to save it in Google Calendar.`,
      });
    };
    const askWhen = (reply) => {
      const r = parseDateTime(reply);
      if (r.date) return proceed(r.date);
      botSay("I still didn't catch a time. Try “tomorrow at 9 am” or “in 30 minutes”.");
      state.pending = { resume: askWhen };
    };
    if (date) return proceed(date);
    state.pending = { resume: askWhen };
    botSay(`When should I remind you${subject ? ` to ${subject}` : ""}?`, {
      choices: [
        { label: "In 1 hour", value: "in 1 hour" },
        { label: "Tonight 8 PM", value: "tonight" },
        { label: "Tomorrow 9 AM", value: "tomorrow at 9 am" },
      ],
    });
  }

  /* ---------------- Boot ---------------- */
  Store.load();
  parseRoute();
  render();
  scheduleReminders();
  setInterval(() => { if (route.name === "home") renderHome(); }, 60e3);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeAssistant(); closeSheet("rem"); }
  });

  // Exposed for debugging / testing in the console
  window.VoiceNotes = { Store, handleCommand, parseDateTime, googleCalendarUrl };
})();
