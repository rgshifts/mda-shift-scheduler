/* ============================================================
   אתר שיבוצים מדא רמת גן — Application logic
   Server-backed: all accounts, roster, stations, schedules and
   availability live in a Netlify (Postgres) database and sync across
   every device. The browser keeps only an opaque session token and the
   chosen colour theme locally. Every API call is wrapped so a network
   failure degrades gracefully rather than breaking rendering.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- Local (device-only) storage keys ---------------- */
  // Only two things stay on the device: the opaque session token (like a
  // cookie) and the UI theme preference. All application DATA lives server-side.
  var K_TOKEN = "sss_token";  // opaque session token returned by the API
  var K_THEME = "sss_theme";  // "dark" | "light"
  var K_CONTEXT = "sss_white_context"; // false = ATAN, true = white ambulance
  var PRIVATE_STATION_NAMES = { "אמבולנס לבן": true };
  // Admin "view as" mode: { id, name, role } of the user an admin is previewing
  // the app as. Purely client-side — the real session token is untouched, so the
  // banner can drop this key to restore the admin's own view instantly.
  var K_IMPERSONATE = "impersonated_user";

  /* ---------------- Safe localStorage helpers ---------------- */
  function storeGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.warn("storeGet failed for " + key, err);
      return fallback;
    }
  }
  function storeSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn("storeSet failed for " + key, err);
      return false;
    }
  }
  function storeRemove(key) {
    try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
  }

  /* ---------------- API client ---------------- */
  // Thin fetch wrapper: attaches the Bearer token, JSON-encodes the body, and
  // rejects with an Error carrying { status, data } on a non-2xx response.
  function api(method, path, body) {
    // Offline demo preview: the backend/database is unavailable, so short-circuit
    // every request with a rejection. All callers already fall back gracefully
    // (their .catch keeps the seeded sample cache in place), so nothing on the
    // network is ever touched while previewing.
    if (state.demoMode) {
      var demoErr = new Error("demo mode — offline");
      demoErr.status = 0;
      return Promise.reject(demoErr);
    }
    var opts = { method: method, headers: {} };
    if (state.token) opts.headers["Authorization"] = "Bearer " + state.token;
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch("/api/" + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ("HTTP " + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------- Email trigger ---------------- */
  // Fire off a transactional email through the Gmail-backed send-email function.
  // Any client-side flow that needs to notify someone by mail funnels through
  // here so there is a single, clean POST to /api/send-email carrying just the
  // recipient, subject and HTML body. Resolves to the endpoint's JSON response;
  // rejects with an Error (carrying { status }) on a non-2xx reply.
  function sendEmail(to, subject, html) {
    if (state.demoMode) {
      var demoErr = new Error("demo mode — offline");
      demoErr.status = 0;
      return Promise.reject(demoErr);
    }
    return fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: to, subject: subject, html: html })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ("HTTP " + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------- Static config (not data) ---------------- */
  // Shift-type labels/order. Stations reference one of these shift types,
  // which drives the color band and the grouping order in the day view.
  // Chronological day-view order: Night → Morning → Evening.
  var SHIFT_TYPES = [
    { id: "night",   label: "לילה" },
    { id: "morning", label: "בוקר" },
    { id: "evening", label: "ערב"  }
  ];
  function shiftLabel(id) {
    for (var i = 0; i < SHIFT_TYPES.length; i++) { if (SHIFT_TYPES[i].id === id) return SHIFT_TYPES[i].label; }
    return id;
  }
  function shiftOrder(id) {
    for (var i = 0; i < SHIFT_TYPES.length; i++) { if (SHIFT_TYPES[i].id === id) return i; }
    return SHIFT_TYPES.length;
  }

  var SLOTS = [
    { key: "driver",   label: "נהג/ת",        role: "driver", source: "drivers" },
    { key: "medic",    label: "פראמדיק/ית",   role: "medic",  source: "medics"  },
    { key: "intern1",  label: "מלווה א׳",     role: "intern", source: "interns" },
    { key: "intern2",  label: "מלווה ב׳",     role: "intern", source: "interns" }
  ];

  // "סוג המשימה" — the kind of entry a board card represents. 'shift' (the default)
  // keeps the standard driver/paramedic/escort crew; the other three are events
  // with no crew whose participants live in a free-form "משתלמים" list instead.
  var TASK_TYPES = [
    { id: "shift",    label: "משמרת" },
    { id: "training", label: "יום תרגול / עיון" },
    { id: "ceremony", label: "טקס" },
    { id: "other",    label: "אחר" }
  ];
  // Normalise any stored/legacy value to a known task type, defaulting to 'shift'.
  function knownTaskType(id) {
    for (var i = 0; i < TASK_TYPES.length; i++) { if (TASK_TYPES[i].id === id) return id; }
    return "shift";
  }
  function taskTypeLabel(id) {
    for (var i = 0; i < TASK_TYPES.length; i++) { if (TASK_TYPES[i].id === id) return TASK_TYPES[i].label; }
    return TASK_TYPES[0].label;
  }

  // Availability ranking a trainee can submit per shift type.
  var AVAIL_OPTIONS = [
    { key: "prefer", label: "מעדיף להשתבץ", short: "מעדיף",     cls: "prefer" },
    { key: "avoid",  label: "מעדיף שלא",    short: "מעדיף שלא", cls: "avoid"  },
    { key: "cannot", label: "לא יכול",      short: "לא יכול",   cls: "cannot" }
  ];
  function availLabel(key) {
    for (var i = 0; i < AVAIL_OPTIONS.length; i++) { if (AVAIL_OPTIONS[i].key === key) return AVAIL_OPTIONS[i].short; }
    return "";
  }
  function availClass(key) {
    for (var i = 0; i < AVAIL_OPTIONS.length; i++) { if (AVAIL_OPTIONS[i].key === key) return AVAIL_OPTIONS[i].cls; }
    return "";
  }

  // Priority buckets for the smart trainee picker, in display order. A trainee
  // lands in the bucket matching their submitted preference for the day + shift
  // ('prefer'/'avoid'/'cannot'); everyone else falls into "no preference".
  var ASSIGN_GROUPS = [
    { key: "prefer", title: "מעדיפים להשתבץ",   cls: "prefer", tag: "מעדיף/ה" },
    { key: "avoid",  title: "מעדיפים שלא",       cls: "avoid",  tag: "מעדיף/ה שלא" },
    { key: "none",   title: "ללא העדפה שהוגשה",  cls: "none",   tag: "" },
    { key: "cannot", title: "אינם יכולים לעבוד", cls: "cannot", tag: "לא יכול/ה" }
  ];

  // Fallback lock configuration before the server value loads.
  var DEFAULT_LOCK = { enabled: false, day: 4, time: "20:00" }; // 4 = Thursday

  // Trainee certification stages ("שלבי הסמכה"), in ascending authorization order.
  // '' (unset) is offered as the first dropdown option. Stages 1–2 are supervised.
  var TRAINEE_STAGES = [
    { key: "",        label: "— ללא שלב —" },
    { key: "stage_1", label: "שלב 1 · משמרות צפייה" },
    { key: "stage_2", label: "שלב 2 · משמרות אנמנזה" },
    { key: "stage_3", label: "שלב 3 · ניהול מקרים לא דחופים" },
    { key: "stage_4", label: "שלב 4 · ניהול כל המקרים" }
  ];
  function stageLabel(key) {
    for (var i = 0; i < TRAINEE_STAGES.length; i++) { if (TRAINEE_STAGES[i].key === (key || "")) return TRAINEE_STAGES[i].label; }
    return TRAINEE_STAGES[0].label;
  }

  // The four real certification stages (dropping the '' "no stage" option) rendered
  // as the trainee's progress tracker on their main view. `short` is the step chip
  // label; `desc` the fuller description shown beneath it.
  var PROGRESS_STAGES = [
    { key: "stage_1", short: "צפייה",           desc: "משמרות צפייה" },
    { key: "stage_2", short: "אנמנזה",          desc: "משמרות אנמנזה" },
    { key: "stage_3", short: "מקרים לא דחופים", desc: "ניהול מקרים לא דחופים" },
    { key: "stage_4", short: "כל המקרים",       desc: "ניהול כל המקרים" }
  ];

  // Single source of truth for navigation-tab visibility permissions in the
  // role matrix UI. The order here is the exact order rendered under
  // "נראות לשוניות ניווט" and drives the X/13 denominator everywhere.
  var NAV_TAB_PERMISSION_ITEMS = [
    { tab: "dashboard",    key: "canViewDashboard",   label: "לוח בקרה" },
    { tab: "schedule",     key: "canViewSchedule",    label: "לוח שיבוצים" },
    { tab: "monthly",      key: "canViewMonthly",     label: "שיבוץ חודשי" },
    { tab: "engine",       key: "canViewEngine",      label: "שיבוץ מבוסס AI" },
    { tab: "forms",        key: "canViewForms",       label: "המשמרות שלי" },
    { tab: "tracking",     key: "canViewTracking",    label: "מעקב ביצוע טפסים" },
    { tab: "placement",    key: "canViewPlacement",   label: "הערות שיבוץ" },
    { tab: "trainee-view", key: "canViewTraineeView", label: "צפייה בסידור לחניך" },
    { tab: "weekly",       key: "canViewWeekly",      label: "הגשת אילוצים שבועית" },
    { tab: "users",        key: "canViewUsers",       label: "ניהול משתמשים והרשאות" },
    { tab: "stations",     key: "canViewStations",    label: "ניהול תחנות ומשמרות" },
    { tab: "roster",       key: "canViewRoster",      label: "ניהול סגל ורשימות" },
    { tab: "white-ambulance", key: "canViewWhiteAmbulance", label: "ניהול אמבולנס לבן" }
  ];

  // Permission flags shown in the role-management matrix, in display order. Each
  // maps to a boolean on a role's `permissions` object (and the `roles` table).
  var PERM_DEFS = NAV_TAB_PERMISSION_ITEMS.map(function (it) {
    return { key: it.key, label: "לשונית: " + it.label };
  }).concat([
    { key: "canEditSchedule",      label: "עריכת סידור" },
    { key: "canFillChecklist",     label: "מילוי טופס חניכה (עצמי)" },
    { key: "canManageRoles",       label: "ניהול תפקידים והרשאות" },
    { key: "canOverrideChecklist", label: "חתימה על טפסים של אחרים" }
  ]);

  // The permission flags above, organized into the logical sub-categories shown
  // in the role-management panel as collapsible sections. Every PERM_DEFS key
  // belongs to exactly one group; `permDef` resolves a key back to its label.
  var PERM_GROUPS = [
    { id: "schedule",   label: "עריכת סידור",              keys: ["canEditSchedule"] },
    {
      id: "visibility",
      label: "נראות לשוניות ניווט",
      keys: NAV_TAB_PERMISSION_ITEMS.map(function (it) { return it.key; })
    },
    { id: "training",   label: "חניכה וטפסי משתלמים",       keys: ["canFillChecklist", "canOverrideChecklist"] },
    { id: "system",     label: "ניהול מערכת והרשאות",       keys: ["canManageRoles"] }
  ];
  function permDef(key) {
    return PERM_DEFS.filter(function (d) { return d.key === key; })[0];
  }

  var HE_MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
  var HE_WEEKDAYS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
  var HE_WEEKDAYS_SHORT = ["א׳","ב׳","ג׳","ד׳","ה׳","ו׳","ש׳"];

  /* ---------------- App state + server-data cache ---------------- */
  var state = {
    token: null,             // opaque session token
    user: null,              // { id, name, email, role }
    perms: null,             // resolved permission flags for the logged-in user (from the server)
    isWhiteAmbulanceContext: !!storeGet(K_CONTEXT, false),
    viewDate: new Date(),    // month currently shown
    selectedDate: null,      // "YYYY-MM-DD"
    isLoginView: true,       // auth screen: true = login form, false = registration form
    authMode: "login",       // auth screen mode: 'login' | 'register' | 'forgot' | 'reset' | 'verify'
    resetToken: null,        // password-reset token pulled from /reset-password?token=…
    usersPoll: null,         // interval handle: live polling while the Users tab is open
    assign: null,            // open smart-assignment picker: { field, pop, onDoc, onScroll }
    nameMenu: null,          // open trainee-combobox dropdown: { input, anchor, pop, iso, onDoc, onScroll }
    actionsMenu: null,       // open user-row actions dropdown: { trigger, pop, onDoc, onScroll, onKey }
    importFile: null,        // file staged in the "ייבוא סידור ממד״א" dropzone, pending import
    whiteAmbulanceDate: null, // isolated private import target day (independent of the main schedule board)
    whiteViewDate: new Date(), // month shown in the white-ambulance schedule/monthly views
    subWeek: null,           // engine tab: Sunday (Date) of the week shown in the submission tracker
    autoWeek: null,          // engine tab: Sunday (Date) of the week the auto-assign run targets (picker)
    weeklyWeek: null,        // weekly tab: Sunday (Date) of the week a trainee is submitting requests for
    matrixFocusWeek: null,   // monthly matrix: ISO Sunday to scope the grid to, set after an engine run
    subPending: [],          // engine tab: names with no availability submitted for state.subWeek
    demoMode: false,         // offline "Demo Bypass" admin preview (netlify.app, passcode) — no backend
    revealTimer: null,       // pending setTimeout that re-renders the open day to auto-unmask the crew
    scheduleEditMode: false, // daily board: admins start read-only and opt into editing via the pencil icon
    matrixEditMode: false,   // monthly matrix: same opt-in edit toggle so the grid is click-safe by default
    matrixZoom: 1.0,         // monthly matrix: live table zoom scale (0.7–1.3), applied via CSS transform on the grid
    undoStack: []            // global "ביטול פעולה אחרונה" history: reversible snapshots of the last scheduling changes across the daily board and the monthly grid
  };

  // The inline auto-save status pill for the open day board, plus the timer that
  // fades it back to idle after a successful save. Re-pointed on every day render.
  var autosaveEl = null;
  var autosaveHideTimer = null;

  // In-memory mirror of the server data, refreshed from the API. Render
  // functions read from here synchronously; mutations write through the API and
  // then refresh the relevant slice.
  var cache = {
    stations: [],            // [{ id, name, shift, hours }]
    roster: [],              // [{ id, name }]
    lockConfig: { enabled: false, day: 4, time: "20:00" },
    crewRevealHours: 0,      // hours-before-shift window after which trainees/viewers see the generic crew names (0 = always visible)
    deadlineReminderHours: 24, // hours before the weekly lock at which non-submitting trainees get an email reminder (admin-configurable)
    stageTargets: { stage1RequiredShifts: 10, stage2RequiredShifts: 15, stage3RequiredShifts: 20, stage4RequiredShifts: 25 }, // completed-shift target to clear each certification stage (admin-configurable)
    publishedWeeks: [],      // ISO Sundays of weeks published to trainees (additive list)
    roles: [],               // dynamic role definitions: [{ id, name, isSystem, defaultWeeklyQuota, permissions:{...} }]
    courses: [],             // dynamic course catalog: ["קורס קפ״ק", ...] (admin-managed)
    users: [],               // admin only: [{ id, name, email, role, status, shiftTarget, course, activeTrainee, isVolunteer, isIntern, isApprovedTutor, shabbatKeeper }]
    weekCounts: {},          // admin only: { name: shiftsThisWeek } for the relevant week (weekly quota display)
    monthDates: {},          // { iso: true } for days the logged-in user is scheduled
    monthDays: {},           // { iso: [{ station, shift }] } the user's own assignments per day
    day: null,               // { iso, shifts, hidden, custom, availEntries } for the open day
    week: null,              // { start, byDate } the trainee's weekly request grid
    formRows: [],            // Forms Checklist tab: [{ date, shift, station, trainee, slot, source, refId, completed, canToggle }]
    matrix: {},              // admin monthly matrix: { iso: { stationId: {driver,medic,intern1,intern2,note} } }
    matrixHidden: {},        // admin monthly matrix: { iso: [stationId,...] } stations pruned from that date
    matrixAvail: {},         // memoized day availability for the matrix picker: { iso: [entries] }
    traineeViewEditMode: false, // trainee-view: admin edit mode toggle
    traineeAssign: null,     // trainee-view: open assignment popover state
    privateDaily: [],        // exact-admin-only: isolated daily Excel import rows for the white-ambulance tab
    whiteMonthDates: {},     // isolated white calendar markers: { iso: true }
    whiteMonthByDate: {},    // isolated private daily rows grouped by ISO date
    whiteMonthMatrix: {},    // white monthly schedule matrix: { iso: { stationId: entry } }
    whiteStations: [],       // white-ambulance station definitions only
    whiteDay: null,          // white day board payload: { iso, shifts }
    whiteRequests: [],       // manual white placement requests queue
    analytics: null          // last-loaded admin dashboard metrics
  };

  /* ---------------- Element refs ---------------- */
  var el = {};
  function byId(id) { return document.getElementById(id); }

  /* ---------------- Theme (dark mode) ---------------- */
  var ICON_SUN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function getStoredTheme() {
    var t = storeGet(K_THEME, null);
    if (t === "dark" || t === "light") return t;
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch (e) { /* ignore */ }
    return "light";
  }

  function applyTheme(theme) {
    var dark = theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    var label = dark ? "מעבר למצב בהיר" : "מעבר למצב כהה";
    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-toggle]"), function (btn) {
      btn.innerHTML = dark ? ICON_MOON : ICON_SUN;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    });
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    var next = cur === "dark" ? "light" : "dark";
    storeSet(K_THEME, next);
    applyTheme(next);
  }

  function contextQuery(path) {
    if (!state.isWhiteAmbulanceContext) return path;
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "context=white-ambulance";
  }

  function contextToggleLabel() {
    return state.isWhiteAmbulanceContext ? "מעבר לאתר אט״ן" : "מעבר לאתר לבן";
  }

  function canShowWhiteAmbulanceContextToggle() {
    return !!(state.user && (state.user.role === "admin" || canManageRoles()));
  }

  function renderContextToggle() {
    if (!el.contextToggle) return;
    if (!canShowWhiteAmbulanceContextToggle()) {
      el.contextToggle.hidden = true;
      return;
    }
    var label = contextToggleLabel();
    el.contextToggle.hidden = false;
    el.contextToggle.textContent = label;
    el.contextToggle.setAttribute("aria-label", label);
    el.contextToggle.setAttribute("title", label);
  }

  function setWhiteAmbulanceContext(on) {
    state.isWhiteAmbulanceContext = !!on;
    storeSet(K_CONTEXT, state.isWhiteAmbulanceContext);
    renderContextToggle();
    reloadContextualViews();
  }

  function toggleWhiteAmbulanceContext() {
    if (!canShowWhiteAmbulanceContextToggle()) return;
    setWhiteAmbulanceContext(!state.isWhiteAmbulanceContext);
  }

  function reloadContextualViews() {
    return refreshStations().then(function () {
      var active = document.querySelector(".nav-tab.is-active");
      var tab = active ? active.getAttribute("data-tab") : "schedule";
      if (tab === "schedule") {
        return loadMonth().then(function () {
          if (!state.selectedDate) return;
          return loadDay(state.selectedDate).then(function () {
            if (state.selectedDate && el.dayDetail && !el.dayDetail.hidden) renderDayDetail(state.selectedDate);
          });
        });
      }
      if (tab === "monthly") return loadMatrix();
      if (tab === "forms" || tab === "tracking") return loadForms();
      if (tab === "stations") return renderStations();
      if (tab === "dashboard") return loadDashboard();
      return Promise.resolve();
    });
  }

  /* ---------------- Availability + lock helpers (client UI) ---------------- */
  // Server is the source of truth; this mirrors the deadline rule for the UI.
  function getLockConfig() {
    var cfg = cache.lockConfig || {};
    return {
      enabled: !!cfg.enabled,
      day: (typeof cfg.day === "number") ? cfg.day : DEFAULT_LOCK.day,
      time: cfg.time || DEFAULT_LOCK.time
    };
  }

  function parseTime(t) {
    var p = String(t || "20:00").split(":");
    return { h: (+p[0] || 0), m: (+p[1] || 0) };
  }

  // Sunday 00:00 of the week that contains the given ISO date.
  function weekStartOf(iso) {
    var parts = iso.split("-");
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // back to Sunday (Israeli week start)
    return d;
  }

  // ISO 'YYYY-MM-DD' for a Date in local time.
  function isoOf(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  // The Sunday (ISO) of the week containing `iso`; the key the weekly quota and
  // the week-count endpoint use.
  function weekStartIso(iso) {
    return isoOf(weekStartOf(iso));
  }
  // Today's local ISO date.
  function todayIso() {
    return isoOf(new Date());
  }

  // Sunday (Date) of the *next* week — the week schedulers usually staff. Used as
  // the default target for the auto-assign week picker.
  function upcomingWeekStart() {
    var thisWeek = weekStartOf(todayIso());
    return new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() + 7);
  }

  function getWeekDeadline(iso) {
    var cfg = getLockConfig();
    if (!cfg.enabled) return null;
    var ws = weekStartOf(iso);
    var back = (ws.getDay() - cfg.day + 7) % 7;
    if (back === 0) back = 7;
    var deadline = new Date(ws.getTime());
    deadline.setDate(deadline.getDate() - back);
    var t = parseTime(cfg.time);
    deadline.setHours(t.h, t.m, 0, 0);
    return deadline;
  }

  // Trainees are locked once the deadline passes; admins are never locked. The
  // server enforces this too — this is only for UI affordance.
  function isAvailLocked(iso) {
    if (isAdmin()) return false;
    var deadline = getWeekDeadline(iso);
    if (!deadline) return false;
    return new Date().getTime() > deadline.getTime();
  }

  // Combobox suggestions for a slot: the managed roster names + approved
  // registered users, de-duplicated. Free-typed values are still saved.
  function comboNames() {
    var out = [];
    var seen = {};
    function add(n) { if (n && !seen[n]) { seen[n] = true; out.push(n); } }
    (cache.roster || []).forEach(function (r) { add(r.name); });
    (cache.users || []).forEach(function (u) {
      if ((u.status || "Approved") === "Approved") add(u.name);
    });
    return out;
  }

  /* ---------------- Init ---------------- */
  function init() {
    el.loginView   = byId("login-view");
    el.appView     = byId("app-view");
    el.loginForm   = byId("login-form");
    el.loginEmail  = byId("login-email");
    el.loginPass   = byId("login-password");
    el.loginError  = byId("login-error");
    el.loginNotice = byId("login-notice");
    el.registerForm  = byId("register-form");
    el.registerName  = byId("register-name");
    el.registerEmail = byId("register-email");
    el.registerPass  = byId("register-password");
    el.registerError = byId("register-error");
    el.forgotForm    = byId("forgot-form");
    el.forgotEmail   = byId("forgot-email");
    el.forgotError   = byId("forgot-error");
    el.forgotNotice  = byId("forgot-notice");
    el.resetForm     = byId("reset-form");
    el.resetPass     = byId("reset-password");
    el.resetPassConfirm = byId("reset-password-confirm");
    el.resetError    = byId("reset-error");
    el.resetNotice   = byId("reset-notice");
    el.verifyPanel   = byId("verify-panel");
    el.verifyTitle   = byId("verify-title");
    el.verifyMessage = byId("verify-message");
    el.userName    = byId("user-name");
    el.roleBadge   = byId("user-role-badge");
    el.contextToggle = byId("context-toggle");
    // Notification center (bell + dropdown).
    el.notifWrap   = byId("notif-wrap");
    el.notifBell   = byId("notif-bell");
    el.notifBadge  = byId("notif-badge");
    el.notifPanel  = byId("notif-panel");
    el.notifList   = byId("notif-list");
    el.notifMarkAll = byId("notif-mark-all");
    el.notifBroadcast = byId("notif-broadcast");
    el.notifBroadcastMsg = byId("notif-broadcast-msg");
    el.navUsersTab = byId("nav-users-tab");
    el.navScheduleTab = byId("nav-schedule-tab");
    el.navStationsTab = byId("nav-stations-tab");
    el.navRosterTab = byId("nav-roster-tab");
    el.navWeeklyTab = byId("nav-weekly-tab");
    el.navFormsTab = byId("nav-forms-tab");
    el.navTrackingTab = byId("nav-tracking-tab");
    el.navMonthlyTab = byId("nav-monthly-tab");
    el.navEngineTab = byId("nav-engine-tab");
    el.navDashboardTab = byId("nav-dashboard-tab");
    el.tabSchedule = byId("tab-schedule");
    el.traineeProgress = byId("trainee-progress");
    el.tabUsers    = byId("tab-users");
    el.tabStations = byId("tab-stations");
    el.tabRoster   = byId("tab-roster");
    el.tabWeekly   = byId("tab-weekly");
    el.tabForms    = byId("tab-forms");
    el.tabTracking = byId("tab-tracking");
    el.tabMonthly  = byId("tab-monthly");
    el.tabEngine   = byId("tab-engine");
    el.tabWhiteSchedule = byId("tab-white-schedule");
    el.tabWhiteMonthly = byId("tab-white-monthly");
    el.tabWhiteStations = byId("tab-white-stations");
    el.tabWhiteImport = byId("tab-white-import");
    el.tabDashboard = byId("tab-dashboard");
    el.dashboardKpis = byId("dashboard-kpis");
    el.dashTopTrainees = byId("dash-top-trainees");
    el.dashTopMedics = byId("dash-top-medics");
    el.dashboardRefresh = byId("dashboard-refresh");
    el.navPlacementTab = byId("nav-placement-tab");
    el.navMobileSelect = byId("nav-mobile-select");
    el.tabPlacement = byId("tab-placement");
    el.placementList = byId("placement-list");
    el.placementRefresh = byId("placement-refresh");
    el.placementForm = byId("placement-admin-form");
    el.placementUser = byId("placement-user");
    el.placementDate = byId("placement-date");
    el.placementShift = byId("placement-shift");
    el.placementNote = byId("placement-note");
    el.navTraineeViewTab = byId("nav-trainee-view-tab");
    el.tabTraineeView = byId("tab-trainee-view");
    el.traineeViewEditBanner = byId("trainee-view-edit-banner");
    el.traineeViewEditToggle = byId("trainee-view-edit-toggle");
    el.traineeViewSelect = byId("trainee-view-select");
    el.traineeScheduleTable = byId("trainee-schedule-table");
    el.traineeScheduleTbody = byId("trainee-schedule-tbody");
    el.traineeScheduleEmpty = byId("trainee-schedule-empty");
    el.engineMonthLabel = byId("engine-month-label");
    el.engineReport = byId("engine-report");
    el.matrixWrap  = byId("matrix-wrap");
    el.matrixMonthLabel = byId("matrix-month-label");
    el.autoAssignBtn    = byId("auto-assign-btn");
    el.autoWeekInput    = byId("auto-assign-week");
    el.autoWeekRange    = byId("auto-assign-week-range");
    el.autoAssignToggle = byId("auto-assign-toggle");
    el.autoAssignPanel  = byId("auto-assign-panel");
    el.autoAssignList   = byId("auto-assign-list");
    el.autoAssignAll    = byId("auto-assign-all");
    el.autoAssignCount  = byId("auto-assign-count");
    el.submissionToggle    = byId("submission-toggle");
    el.submissionPanel     = byId("submission-panel");
    el.submissionSummary   = byId("submission-summary");
    el.submissionPrevWeek  = byId("submission-prev-week");
    el.submissionNextWeek  = byId("submission-next-week");
    el.submissionWeekLabel = byId("submission-week-label");
    el.submissionSubmittedList  = byId("submission-submitted-list");
    el.submissionPendingList    = byId("submission-pending-list");
    el.submissionSubmittedCount = byId("submission-submitted-count");
    el.submissionPendingCount   = byId("submission-pending-count");
    el.submissionCopyPending    = byId("submission-copy-pending");
    el.importFile       = byId("import-file");
    el.importBtn        = byId("import-btn");
    el.importFileName   = byId("import-file-name");
    el.importDropzone   = byId("import-dropzone");
    el.dailyImportToggle = byId("daily-import-toggle");
    el.dailyImportPanel  = byId("daily-import-panel");
    el.dailyImportFile   = byId("daily-import-file");
    el.dailyImportDropzone = byId("daily-import-dropzone");
    el.dailyImportFileName = byId("daily-import-file-name");
    el.dailyImportDay    = byId("daily-import-day");
    el.dailyImportDayImport = byId("daily-import-day-import");
    el.whiteAmbulancePanel = byId("white-ambulance-panel");
    el.whiteAmbulanceDate = byId("white-ambulance-date");
    el.whiteAmbulanceRefresh = byId("white-ambulance-refresh");
    el.whiteAmbulanceGrid = byId("white-ambulance-grid");
    el.whiteImportGrid = byId("white-import-grid");
    el.whiteImportDate = byId("white-import-date");
    el.whiteImportRefresh = byId("white-import-refresh");
    el.whiteBoardSave = byId("white-board-save");
    el.whiteRequestsForm = byId("white-requests-form");
    el.whiteRequestDate = byId("white-request-date");
    el.whiteRequestStation = byId("white-request-station");
    el.whiteRequestSlot = byId("white-request-slot");
    el.whiteRequestNote = byId("white-request-note");
    el.whiteRequestsTbody = byId("white-requests-tbody");
    el.whiteMonthLabel = byId("white-month-label");
    el.whiteWeekdays = byId("white-calendar-weekdays");
    el.whiteGrid = byId("white-calendar-grid");
    el.whitePrevMonth = byId("white-prev-month");
    el.whiteNextMonth = byId("white-next-month");
    el.whiteMatrixWrap = byId("white-matrix-wrap");
    el.whiteMatrixMonthLabel = byId("white-matrix-month-label");
    el.whiteMatrixPrevMonth = byId("white-matrix-prev-month");
    el.whiteMatrixNextMonth = byId("white-matrix-next-month");
    el.whiteStationForm = byId("white-station-form");
    el.whiteStationName = byId("white-station-name");
    el.whiteStationShift = byId("white-station-shift");
    el.whiteStationHours = byId("white-station-hours");
    el.whiteStationsTbody = byId("white-stations-tbody");
    el.weeklyView  = byId("weekly-view");
    el.formsTbody       = byId("forms-tbody");
    el.formsSearch      = byId("forms-search");
    el.formsShiftFilter = byId("forms-shift-filter");
    el.formsStatusFilter = byId("forms-status-filter");
    // Form-completion tracking tab (managers only): 5 fixed time-bucket sections
    // plus the missing-forms report. Toolbar mirrors the personal tab + trainee picker.
    el.trackingGroups      = byId("tracking-groups");
    el.trackingSearch      = byId("tracking-search");
    el.trackingShiftFilter = byId("tracking-shift-filter");
    el.trackingStatusFilter = byId("tracking-status-filter");
    el.trackingTraineeFilter = byId("tracking-trainee-filter");
    el.trackingTraineeWrap   = byId("tracking-trainee-wrap");
    el.missingFormsSection = byId("missing-forms-section");
    el.missingFormsTbody   = byId("missing-forms-tbody");
    el.usersTbody  = byId("users-tbody");
    el.usersSections = byId("users-sections");
    el.roleForm        = byId("role-form");
    el.roleName        = byId("role-name");
    el.roleNewPerms    = byId("role-new-perms");
    el.rolesMatrixHead = byId("roles-matrix-head");
    el.rolesMatrixBody = byId("roles-matrix-body");
    el.courseForm      = byId("course-form");
    el.courseName      = byId("course-name");
    el.coursesList     = byId("courses-list");
    el.stationsTbody = byId("stations-tbody");
    el.rosterTbody = byId("roster-tbody");
    el.rosterForm  = byId("roster-form");
    el.rosterName  = byId("roster-name");
    el.approvedTutorsTbody = byId("approved-tutors-tbody");
    el.manualTutorForm   = byId("manual-tutor-form");
    el.manualTutorName   = byId("manual-tutor-name");
    el.manualTutorsTbody = byId("manual-tutors-tbody");
    el.stationForm   = byId("station-form");
    el.stationName   = byId("station-name");
    el.stationShift  = byId("station-shift");
    el.stationHours  = byId("station-hours");
    el.lockForm      = byId("lock-form");
    el.lockEnabled   = byId("lock-enabled");
    el.lockDay       = byId("lock-day");
    el.lockTime      = byId("lock-time");
    el.crewRevealForm  = byId("crew-reveal-form");
    el.crewRevealHours = byId("crew-reveal-hours");
    el.deadlineReminderForm = byId("deadline-reminder-form");
    el.deadlineReminderHours = byId("deadline-reminder-hours");
    el.publishForm    = byId("publish-form");
    el.publishWeek    = byId("publish-week");
    el.publishedList  = byId("published-weeks-list");
    el.publishEmailTarget = byId("publish-email-target");
    el.publishTraineeField = byId("publish-trainee-field");
    el.publishTrainee = byId("publish-trainee");
    el.monthLabel  = byId("month-label");
    el.weekdays    = byId("calendar-weekdays");
    el.grid        = byId("calendar-grid");
    el.dayDetail   = byId("day-detail");
    el.toast       = byId("toast");
    el.impBanner   = byId("impersonation-banner");
    if (el.impBanner) el.impBanner.addEventListener("click", exitImpersonation);

    state.token = storeGet(K_TOKEN, null);
    applyTheme(getStoredTheme());
    bindEvents();
    // A /verify-email?token=… or /reset-password?token=… link takes precedence
    // over restoring a session: run that flow on the login screen instead.
    if (handleAuthLink()) return;
    restoreSession();
  }

  /* ---------------- Query-param auth links ----------------
     The verification and reset emails point at /verify-email?token=… and
     /reset-password?token=… (served as index.html via netlify.toml redirects).
     Detect those on load, strip the token from the address bar, and drive the
     matching login-screen flow. Returns true when a link was handled. */
  function detectAuthLink() {
    var path = location.pathname || "";
    var params;
    try { params = new URLSearchParams(location.search || ""); } catch (e) { params = null; }
    var token = params ? (params.get("token") || "").trim() : "";
    if (!token) return null;
    if (/verify-email/.test(path)) return { type: "verify", token: token };
    if (/reset-password/.test(path)) return { type: "reset", token: token };
    return null;
  }

  function handleAuthLink() {
    var link = detectAuthLink();
    if (!link) return false;
    // Drop the token from the URL so it never lingers in history / referrers.
    try { history.replaceState(null, "", "/"); } catch (e) {}
    showLogin();
    if (link.type === "reset") {
      state.resetToken = link.token;
      showAuthMode("reset");
    } else {
      showAuthMode("verify");
      runVerifyEmail(link.token);
    }
    return true;
  }

  // Call the verify-email endpoint and reflect the result in the verify panel.
  function runVerifyEmail(token) {
    setVerifyMessage("מאמת את כתובת הדוא״ל שלך…", "");
    api("POST", "auth/verify-email", { token: token }).then(function () {
      setVerifyMessage("כתובת הדוא״ל אומתה בהצלחה! ניתן להתחבר למערכת. (החשבון עדיין ממתין לאישור גישה של מנהל.)", "ok");
    }).catch(function () {
      setVerifyMessage("קישור האימות אינו תקין או שכבר נעשה בו שימוש. ניתן לבקש קישור חדש או לפנות למנהל.", "err");
    });
  }

  function setVerifyMessage(msg, kind) {
    if (el.verifyMessage) el.verifyMessage.textContent = msg;
    if (el.verifyMessage) {
      el.verifyMessage.className = "login-form-sub" +
        (kind === "ok" ? " is-ok" : kind === "err" ? " is-err" : "");
    }
  }

  // On returning to the tab, re-pull whatever the active view shows so changes
  // made on another device appear without a manual refresh.
  function refreshActiveView() {
    if (!state.user) return;
    if (can("canViewWhiteAmbulance") && el.tabWhiteSchedule && !el.tabWhiteSchedule.hidden) { loadWhiteAmbulancePanel(); return; }
    if (can("canViewWhiteAmbulance") && el.tabWhiteMonthly && !el.tabWhiteMonthly.hidden) { loadWhiteMonthly(); return; }
    if (can("canViewWhiteAmbulance") && el.tabWhiteStations && !el.tabWhiteStations.hidden) { loadWhiteStations(); return; }
    if (can("canViewWhiteAmbulance") && el.tabWhiteImport && !el.tabWhiteImport.hidden) { loadWhiteImportPanel(); return; }
    if (isAdmin() && el.tabUsers && !el.tabUsers.hidden) { refreshUsers(); return; }
    if (isAdmin() && el.tabMonthly && !el.tabMonthly.hidden) { loadMatrix(); return; }
    if (el.tabForms && !el.tabForms.hidden) { loadForms(); return; }
    if (el.tabWeekly && !el.tabWeekly.hidden) { loadWeekly(); return; }
    if (el.tabSchedule && !el.tabSchedule.hidden) {
      loadMonth();
      if (state.selectedDate) {
        var iso = state.selectedDate;
        loadDay(iso).then(function () { if (state.selectedDate === iso) renderDayDetail(iso); });
      }
    }
  }

  function bindEvents() {
    el.loginForm.addEventListener("submit", onLogin);
    el.registerForm.addEventListener("submit", onRegister);
    byId("logout-btn").addEventListener("click", logout);

    byId("show-register").addEventListener("click", function () { showAuthMode("register"); });
    byId("show-login").addEventListener("click", function () { showAuthMode("login"); });
    byId("show-forgot").addEventListener("click", function () { showAuthMode("forgot"); });
    byId("forgot-back").addEventListener("click", function () { showAuthMode("login"); });
    byId("reset-back").addEventListener("click", goToLoginClean);
    byId("verify-continue").addEventListener("click", goToLoginClean);
    if (el.forgotForm) el.forgotForm.addEventListener("submit", onForgotPassword);
    if (el.resetForm) el.resetForm.addEventListener("submit", onResetPassword);

    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-toggle]"), function (btn) {
      btn.addEventListener("click", toggleTheme);
    });
    if (el.contextToggle) {
      el.contextToggle.addEventListener("click", function () {
        toggleWhiteAmbulanceContext();
      });
    }

    // Notification center: toggle the dropdown, mark-all-read, admin broadcast, and
    // close on an outside click / Escape.
    if (el.notifBell) el.notifBell.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleNotifPanel();
    });
    if (el.notifMarkAll) el.notifMarkAll.addEventListener("click", markAllNotificationsRead);
    if (el.notifBroadcast) el.notifBroadcast.addEventListener("submit", onSendBroadcast);
    if (el.notifPanel) el.notifPanel.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { closeNotifPanel(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNotifPanel(); });

    // Static accordion headers (roster + manual-tutors sections). They start
    // closed; clicking toggles .is-open on the surrounding .user-group, which
    // the CSS animates smoothly open/closed.
    Array.prototype.forEach.call(document.querySelectorAll("[data-acc-toggle]"), function (head) {
      head.addEventListener("click", function () {
        var sec = head.closest(".user-group");
        if (!sec) return;
        var open = sec.classList.toggle("is-open");
        head.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });

    el.stationForm.addEventListener("submit", onAddStation);
    el.rosterForm.addEventListener("submit", onAddRosterName);
    if (el.manualTutorForm) el.manualTutorForm.addEventListener("submit", onAddManualTutor);
    el.lockForm.addEventListener("submit", onSaveLockConfig);
    if (el.crewRevealForm) el.crewRevealForm.addEventListener("submit", onSaveCrewReveal);
    if (el.deadlineReminderForm) el.deadlineReminderForm.addEventListener("submit", onSaveDeadlineReminder);
    if (el.roleForm) el.roleForm.addEventListener("submit", onAddRole);
    if (el.courseForm) el.courseForm.addEventListener("submit", onAddCourse);
    if (el.publishForm) el.publishForm.addEventListener("submit", onPublishWeek);
    if (el.publishEmailTarget) el.publishEmailTarget.addEventListener("change", syncPublishTraineeField);
    if (el.publishedList) el.publishedList.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-unpublish]") : null;
      if (btn) onUnpublishWeek(btn.getAttribute("data-unpublish"));
    });

    Array.prototype.forEach.call(document.querySelectorAll(".nav-tab"), function (tab) {
      tab.addEventListener("click", function () { switchTab(tab.getAttribute("data-tab")); });
    });

    // Mobile dropdown mirrors the tab buttons: selecting an option switches the
    // view exactly like clicking a tab.
    if (el.navMobileSelect) {
      el.navMobileSelect.addEventListener("change", function () {
        switchTab(el.navMobileSelect.value);
      });
    }

    // Forms Checklist filters re-render from the in-memory rows (no refetch).
    if (el.formsSearch) el.formsSearch.addEventListener("input", renderForms);
    if (el.formsShiftFilter) el.formsShiftFilter.addEventListener("change", renderForms);
    if (el.formsStatusFilter) el.formsStatusFilter.addEventListener("change", renderForms);
    if (el.trackingSearch) el.trackingSearch.addEventListener("input", renderTracking);
    if (el.trackingShiftFilter) el.trackingShiftFilter.addEventListener("change", renderTracking);
    if (el.trackingStatusFilter) el.trackingStatusFilter.addEventListener("change", renderTracking);
    if (el.trackingTraineeFilter) el.trackingTraineeFilter.addEventListener("change", renderTracking);

    byId("prev-month").addEventListener("click", function () { stepMonth(-1); });
    byId("next-month").addEventListener("click", function () { stepMonth(1); });

    // Monthly matrix has its own month stepper sharing state.viewDate.
    var matrixPrev = byId("matrix-prev-month");
    var matrixNext = byId("matrix-next-month");
    if (matrixPrev) matrixPrev.addEventListener("click", function () { stepMatrixMonth(-1); });
    if (matrixNext) matrixNext.addEventListener("click", function () { stepMatrixMonth(1); });

    // Automated scheduling engine has its own month stepper, also sharing state.viewDate.
    var enginePrev = byId("engine-prev-month");
    var engineNext = byId("engine-next-month");
    if (enginePrev) enginePrev.addEventListener("click", function () { stepEngineMonth(-1); });
    if (engineNext) engineNext.addEventListener("click", function () { stepEngineMonth(1); });

    // Dashboard refresh button.
    if (el.dashboardRefresh) el.dashboardRefresh.addEventListener("click", loadDashboard);
    if (el.placementRefresh) el.placementRefresh.addEventListener("click", loadPlacementNotes);
    if (el.placementForm) el.placementForm.addEventListener("submit", savePlacementNote);
    if (el.traineeViewSelect) el.traineeViewSelect.addEventListener("change", onTraineeViewSelect);

    // Automated scheduling engine controls (engine tab, admin only).
    if (el.autoAssignBtn) el.autoAssignBtn.addEventListener("click", runAutoAssign);
    if (el.autoWeekInput) el.autoWeekInput.addEventListener("change", onAutoWeekPick);
    if (el.autoAssignToggle) {
      el.autoAssignToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleAutoAssignPanel();
      });
    }
    if (el.autoAssignAll) el.autoAssignAll.addEventListener("change", onAutoAssignAllToggle);

    // Weekly availability submission tracking (engine tab, admin only).
    if (el.submissionToggle) el.submissionToggle.addEventListener("click", toggleSubmissionPanel);
    if (el.submissionPrevWeek) el.submissionPrevWeek.addEventListener("click", function () { stepSubmissionWeek(-1); });
    if (el.submissionNextWeek) el.submissionNextWeek.addEventListener("click", function () { stepSubmissionWeek(1); });
    if (el.submissionCopyPending) el.submissionCopyPending.addEventListener("click", copyPendingNames);

    // Bulk schedule import (engine tab, admin only): file picker + drag-and-drop.
    if (el.importFile) el.importFile.addEventListener("change", function () {
      onImportFileSelected(el.importFile.files && el.importFile.files[0]);
    });
    if (el.importBtn) el.importBtn.addEventListener("click", runImport);
    // Daily roster Excel ingestion (admin): expand/collapse + file picker / drop.
    if (el.dailyImportFile) el.dailyImportFile.addEventListener("change", function () {
      runDailyImport(el.dailyImportFile.files && el.dailyImportFile.files[0]);
    });
    if (el.whiteAmbulanceDate) el.whiteAmbulanceDate.addEventListener("change", onWhiteAmbulanceDateChange);
    if (el.whiteImportDate) el.whiteImportDate.addEventListener("change", onWhiteImportDateChange);
    if (el.whiteAmbulanceRefresh) el.whiteAmbulanceRefresh.addEventListener("click", loadWhiteAmbulancePanel);
    if (el.whiteImportRefresh) el.whiteImportRefresh.addEventListener("click", loadWhiteImportPanel);
    if (el.whiteBoardSave) el.whiteBoardSave.addEventListener("click", saveWhiteScheduleBoard);
    if (el.whiteRequestsForm) el.whiteRequestsForm.addEventListener("submit", onSubmitWhiteRequest);
    if (el.whitePrevMonth) el.whitePrevMonth.addEventListener("click", function () { stepWhiteMonth(-1); });
    if (el.whiteNextMonth) el.whiteNextMonth.addEventListener("click", function () { stepWhiteMonth(1); });
    if (el.whiteMatrixPrevMonth) el.whiteMatrixPrevMonth.addEventListener("click", function () { stepWhiteMonth(-1); });
    if (el.whiteMatrixNextMonth) el.whiteMatrixNextMonth.addEventListener("click", function () { stepWhiteMonth(1); });
    if (el.whiteStationForm) el.whiteStationForm.addEventListener("submit", onAddWhiteStation);
    if (el.dailyImportDropzone) {
      ["dragenter", "dragover"].forEach(function (ev) {
        el.dailyImportDropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          el.dailyImportDropzone.classList.add("is-drag");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        el.dailyImportDropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          el.dailyImportDropzone.classList.remove("is-drag");
        });
      });
      el.dailyImportDropzone.addEventListener("drop", function (e) {
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        runDailyImport(file);
      });
    }
    if (el.importDropzone) {
      ["dragenter", "dragover"].forEach(function (ev) {
        el.importDropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          el.importDropzone.classList.add("is-drag");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        el.importDropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          el.importDropzone.classList.remove("is-drag");
        });
      });
      el.importDropzone.addEventListener("drop", function (e) {
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        onImportFileSelected(file);
      });
    }
    // Click anywhere outside the open panel closes it.
    document.addEventListener("click", function (e) {
      if (!el.autoAssignPanel || el.autoAssignPanel.hidden) return;
      if (el.autoAssignPanel.contains(e.target)) return;
      if (el.autoAssignToggle && el.autoAssignToggle.contains(e.target)) return;
      toggleAutoAssignPanel(false);
    });

    // Cross-device refresh on focus.
    window.addEventListener("focus", refreshActiveView);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refreshActiveView();
    });

    // Publish the sticky-header offset now and keep it fresh as the layout
    // reflows (the topbar height changes between the desktop row and the mobile
    // stacked layout, and when the impersonation banner appears).
    updateStickyOffset();
    window.addEventListener("resize", updateStickyOffset);
  }

  // Measures the combined height of the pinned chrome (impersonation banner, if
  // shown, plus the sticky topbar) and publishes it as the CSS custom property
  // --stuck-top. The day-board's blue active-day header sticks to that offset so
  // it never slides under the translucent topbar.
  function updateStickyOffset() {
    var top = 0;
    var banner = document.querySelector(".impersonation-banner");
    if (banner && !banner.hidden) top += banner.offsetHeight;
    var bar = document.querySelector(".topbar");
    if (bar) top += bar.offsetHeight;
    document.documentElement.style.setProperty("--stuck-top", top + "px");
  }

  /* ---------------- Auth ---------------- */
  function onLogin(e) {
    e.preventDefault();
    hideError();
    hideNotice();
    var email = (el.loginEmail.value || "").trim().toLowerCase();
    var pass  = el.loginPass.value || "";

    if (!email || !pass) { showError("יש להזין דוא״ל וסיסמה."); return; }

    api("POST", "auth/login", { email: email, password: pass }).then(function (data) {
      state.token = data.token;
      storeSet(K_TOKEN, data.token);
      el.loginForm.reset();
      return bootstrapAndEnter();
    }).catch(function (err) {
      // Offline preview escape hatch: on a Netlify preview/deploy URL where the
      // database may be unreachable, the passcode "demo2026" drops into a mock
      // admin state with sample data so the new screens can be reviewed safely.
      if (isDemoEligible() && pass === DEMO_PASSCODE) { enterDemoMode(); return; }
      if (err && err.status === 403) {
        showError("גישתך חסומה. החשבון עדיין ממתין לאישור מנהל.");
      } else if (err && err.status === 401) {
        showError("פרטי ההתחברות שגויים. נסו שוב.");
      } else {
        showError("אירעה תקלה בהתחברות. נסו שוב.");
      }
    });
  }

  function onRegister(e) {
    e.preventDefault();
    hideRegError();
    var name  = (el.registerName.value || "").trim();
    var email = (el.registerEmail.value || "").trim().toLowerCase();
    var pass  = el.registerPass.value || "";

    if (!name || !email || !pass) { showRegError("יש למלא שם מלא, דוא״ל וסיסמה."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showRegError("כתובת הדוא״ל אינה תקינה."); return; }

    api("POST", "auth/register", { name: name, email: email, password: pass }).then(function () {
      el.registerForm.reset();
      showAuthMode("login");
      showNotice("ההרשמה בוצעה בהצלחה, יש לאשר את כתובת המייל (ייתכן והגיע לתיבת הספאם או דואר זבל), לאחר מכן יש להמתין לאישור מנהל.");
    }).catch(function (err) {
      if (err && err.status === 409) {
        showRegError("כתובת הדוא״ל כבר רשומה במערכת.");
      } else if (err && err.status === 400) {
        showRegError("כתובת הדוא״ל אינה תקינה.");
      } else {
        showRegError("ההרשמה נכשלה. נסו שוב.");
      }
    });
  }

  function showAuthMode(mode) {
    var allowed = { login: 1, register: 1, forgot: 1, reset: 1, verify: 1 };
    state.authMode = allowed[mode] ? mode : "login";
    state.isLoginView = state.authMode === "login"; // kept for any legacy reference
    renderAuthView();
  }

  function renderAuthView() {
    var mode = state.authMode || "login";
    el.loginForm.hidden = mode !== "login";
    el.registerForm.hidden = mode !== "register";
    if (el.forgotForm) el.forgotForm.hidden = mode !== "forgot";
    if (el.resetForm) el.resetForm.hidden = mode !== "reset";
    if (el.verifyPanel) el.verifyPanel.hidden = mode !== "verify";
    hideError();
    hideRegError();
    hideForgotError(); hideForgotNotice();
    hideResetError(); hideResetNotice();
    if (mode !== "login") hideNotice();
  }

  // Forgot-password: request a recovery link. The server always answers ok (so it
  // can't reveal whether an address is registered); reflect that neutral success.
  function onForgotPassword(e) {
    e.preventDefault();
    hideForgotError();
    hideForgotNotice();
    var email = (el.forgotEmail.value || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showForgotError("יש להזין כתובת דוא״ל תקינה.");
      return;
    }
    api("POST", "auth/forgot-password", { email: email }).then(function () {
      el.forgotForm.reset();
      showForgotNotice("במידה וקיים חשבון עם כתובת המייל הזו, נשלח קישור לאיפוס הסיסמא. יש לבדוק גם בתיקיית הספאם (דואר זבל)!");
    }).catch(function () {
      showForgotError("אירעה תקלה בשליחת הבקשה. נסו שוב.");
    });
  }

  // Reset-password: submit the new password against the token from the email link.
  function onResetPassword(e) {
    e.preventDefault();
    hideResetError();
    hideResetNotice();
    var pass = el.resetPass.value || "";
    var confirm = el.resetPassConfirm.value || "";
    if (pass.length < 6) { showResetError("הסיסמה חייבת לכלול לפחות 6 תווים."); return; }
    if (pass !== confirm) { showResetError("הסיסמאות אינן תואמות."); return; }
    if (!state.resetToken) { showResetError("קישור האיפוס חסר או אינו תקין. בקשו קישור חדש."); return; }

    api("POST", "auth/reset-password", { token: state.resetToken, password: pass }).then(function () {
      el.resetForm.reset();
      state.resetToken = null;
      showAuthMode("login");
      showNotice("הסיסמה עודכנה בהצלחה! ניתן להתחבר עם הסיסמה החדשה.");
    }).catch(function (err) {
      if (err && err.status === 400) {
        showResetError("קישור האיפוס אינו תקין או שתוקפו פג. בקשו קישור חדש מתוך “שכחת סיסמה?”.");
      } else {
        showResetError("עדכון הסיסמה נכשל. נסו שוב.");
      }
    });
  }

  // Clear the login view back to the login form and normalise the URL — used by
  // the reset/verify "back to login" buttons so no stale token path remains.
  function goToLoginClean() {
    state.resetToken = null;
    try { history.replaceState(null, "", "/"); } catch (e) {}
    showAuthMode("login");
  }

  // Pull the full app snapshot in one request, then enter the app.
  function bootstrapAndEnter() {
    return api("GET", "bootstrap").then(function (data) {
      applyBootstrap(data);
      // Remember the real, logged-in account separately from whatever identity
      // is currently on screen, so impersonation can be entered and exited
      // without another round-trip.
      state.realUser = { id: data.user.id, name: data.user.name, email: data.user.email, role: data.user.role, traineeStage: data.user.traineeStage || "", shiftCount: data.user.shiftCount || 0, restrictNightShifts: !!(data.user && data.user.restrictNightShifts), restrictWeekendShifts: !!(data.user && data.user.restrictWeekendShifts) };
      state.realPerms = data.myPerms || defaultPerms(data.user && data.user.role);
      enterImpersonationAware();
    });
  }

  function applyBootstrap(data) {
    cache.stations = filterVisibleStations(data.stations || [], data.user && data.user.role);
    cache.roster = data.roster || [];
    cache.lockConfig = data.lockConfig || { enabled: false, day: DEFAULT_LOCK.day, time: DEFAULT_LOCK.time };
    cache.crewRevealHours = normalizeRevealHours(data.crewRevealHours);
    cache.deadlineReminderHours = normalizeDeadlineHours(data.deadlineReminderHours);
    cache.stageTargets = normalizeStageTargets(data.stageTargets);
    // The logged-in user's OWN role stage targets — what their certification
    // progress bar divides completed shifts against. Falls back to the global
    // targets when the server didn't send a role-specific set.
    cache.myStageTargets = normalizeStageTargets(data.myStageTargets || data.stageTargets);
    cache.publishedWeeks = data.publishedWeeks || [];
    cache.roles = data.roles || [];
    cache.courses = data.courses || [];
    cache.users = data.users || [];
    // The current user's resolved permission flags drive every UI gate below.
    state.perms = data.myPerms || defaultPerms(data.user && data.user.role);
  }

  function restoreSession() {
    if (!state.token) { showLogin(); return; }
    bootstrapAndEnter().catch(function () {
      // Stale/expired token — drop it and show the login screen.
      state.token = null;
      storeRemove(K_TOKEN);
      showLogin();
    });
  }

  function logout() {
    var token = state.token;
    stopUsersPolling();
    clearRevealTimer();
    closeNotifPanel();
    notifState.items = [];
    notifState.unread = 0;
    renderNotifications();
    state.token = null;
    state.user = null;
    state.demoMode = false;
    state.selectedDate = null;
    storeRemove(K_TOKEN);
    storeRemove(K_IMPERSONATE);
    document.body.classList.remove("imp-active");
    if (el.impBanner) el.impBanner.hidden = true;
    hideNotice();
    showLogin();
    if (token) {
      // Best-effort server-side session teardown.
      fetch("/api/auth/logout", { method: "POST", headers: { "Authorization": "Bearer " + token } }).catch(function () {});
    }
  }

  function showLogin() {
    el.appView.hidden = true;
    el.loginView.setAttribute("aria-hidden", "false");
    el.loginView.style.display = "";
    showAuthMode("login");
  }

  // The top-of-page "view only" banner was removed from the DOM; its role now
  // lives inside the monthly toolbar (see renderMatrix), which shows a status
  // line that swaps text with the pencil. Each edit-mode toggle re-renders its
  // own view, so there is no standalone element left to keep in sync here.

  function enterApp(user) {
    state.user = { id: user.id, name: user.name, email: user.email, role: user.role, traineeStage: user.traineeStage, shiftCount: user.shiftCount, restrictNightShifts: !!user.restrictNightShifts, restrictWeekendShifts: !!user.restrictWeekendShifts };
    el.loginView.setAttribute("aria-hidden", "true");
    // Fully remove the login wrapper from layout. `.login-view` is `display:grid`
    // and nothing hides it on aria-hidden alone, so without this the broken login
    // card stays painted at the top of the screen above the app after sign-in.
    el.loginView.style.display = "none";
    el.appView.hidden = false;

    el.userName.textContent = user.name;
    // Visibility is driven by the resolved permission flags, never the role
    // string: `manage` controls user/role administration, `edit` controls
    // schedule editing, and `elevated` (= either) marks a non-trainee account.
    var manage = canManageRoles();
    var edit = canEditSchedule();
    el.roleBadge.textContent = roleLabel(user.role);
    el.roleBadge.className = "role-badge " + (manage ? "admin" : edit ? "editor" : "viewer");

    if (el.navUsersTab) el.navUsersTab.hidden = !can("canViewUsers");
    if (el.navStationsTab) el.navStationsTab.hidden = !can("canViewStations");
    if (el.navRosterTab) el.navRosterTab.hidden = !can("canViewRoster");
    if (el.navEngineTab) el.navEngineTab.hidden = !can("canViewEngine");
    if (el.navWeeklyTab) el.navWeeklyTab.hidden = !can("canViewWeekly");
    // Navigation links driven by the granular per-sub-tab visibility flags, so an
    // admin can grant/revoke each link per role from the permissions matrix.
    if (el.navScheduleTab) el.navScheduleTab.hidden = !can("canViewSchedule");
    if (el.navMonthlyTab) el.navMonthlyTab.hidden = !can("canViewMonthly");
    if (el.navDashboardTab) el.navDashboardTab.hidden = !can("canViewDashboard");
    if (el.navFormsTab) el.navFormsTab.hidden = !can("canViewForms");
    if (el.navTrackingTab) el.navTrackingTab.hidden = !can("canViewTracking");
    if (el.navPlacementTab) el.navPlacementTab.hidden = !can("canViewPlacement");
    if (el.navTraineeViewTab) el.navTraineeViewTab.hidden = !can("canViewTraineeView");
    if (!can("canViewWhiteAmbulance")) {
      state.isWhiteAmbulanceContext = false;
      storeRemove(K_CONTEXT);
    }
    renderContextToggle();
    if (!can("canViewWhiteAmbulance")) {
      clearDailyImportFile();
      cache.privateDaily = [];
      cache.whiteRequests = [];
    }
    // Keep the mobile dropdown aligned with the freshly applied tab visibility.
    var activeNav = document.querySelector(".nav-tab.is-active");
    syncMobileNav(activeNav ? activeNav.getAttribute("data-tab") : "schedule");
    // The trainee dropdown lives in the manager-only "מעקב ביצוע טפסים" tab; reset
    // its selection whenever permissions are (re)applied.
    if (el.trackingTraineeFilter && !isAdmin()) el.trackingTraineeFilter.value = "all";

    // Notification center: the broadcast composer is manager-only; the bell itself
    // is shown to everyone. Load the feed now and start the lightweight poll.
    if (el.notifBroadcast) el.notifBroadcast.hidden = !(manage || edit);
    closeNotifPanel();
    loadNotifications();
    startNotifPolling();

    // Preload the current user's placement notes so the schedule view can surface
    // any targeted deployment inline on the relevant day (staff get every note).
    loadPlacementNotes();

    switchTab("schedule");
    loadMonth();
  }

  /* ---------------- Notification center ----------------
     A bell in the topbar showing the current user's recent notifications (their own
     plus every global/broadcast one), an unread badge, and a "mark all as read"
     control. Managers additionally get a composer to broadcast a custom message to
     all trainees. The feed is polled on a slow interval and refreshed whenever the
     panel is opened. Every render is built with createElement so notification text
     (which can include user-authored broadcast content) is never injected as HTML. */
  var notifState = { items: [], unread: 0, open: false, pollTimer: null, loading: false };

  function startNotifPolling() {
    if (notifState.pollTimer) return;
    // Refresh the unread badge every 60s. Demo mode short-circuits the API, so the
    // catch simply leaves the badge cleared.
    notifState.pollTimer = window.setInterval(function () {
      if (state.user && !state.demoMode) loadNotifications();
    }, 60000);
  }

  function loadNotifications() {
    if (!state.user || state.demoMode) { renderNotifications(); return; }
    if (notifState.loading) return;
    notifState.loading = true;
    api("GET", "notifications").then(function (data) {
      notifState.items = (data && data.notifications) || [];
      notifState.unread = (data && typeof data.unread === "number") ? data.unread : 0;
      renderNotifications();
    }).catch(function () {
      // Leave the last-known state in place on a transient error.
    }).then(function () { notifState.loading = false; });
  }

  function renderNotifications() {
    // Badge.
    if (el.notifBadge) {
      if (notifState.unread > 0) {
        el.notifBadge.textContent = notifState.unread > 99 ? "99+" : String(notifState.unread);
        el.notifBadge.hidden = false;
      } else {
        el.notifBadge.hidden = true;
      }
    }
    if (!el.notifList) return;
    el.notifList.textContent = "";
    if (!notifState.items.length) {
      var empty = document.createElement("div");
      empty.className = "notif-empty";
      empty.textContent = "אין התראות חדשות";
      el.notifList.appendChild(empty);
      return;
    }
    notifState.items.forEach(function (n) {
      var item = document.createElement("div");
      item.className = "notif-item" + (n.isRead ? "" : " is-unread");
      var title = document.createElement("p");
      title.className = "notif-item-title";
      title.textContent = n.title || notifTypeLabel(n.type);
      item.appendChild(title);
      if (n.message) {
        var msg = document.createElement("p");
        msg.className = "notif-item-msg";
        msg.textContent = n.message;
        item.appendChild(msg);
      }
      var time = document.createElement("span");
      time.className = "notif-item-time";
      time.textContent = notifTimeLabel(n.createdAt);
      item.appendChild(time);
      el.notifList.appendChild(item);
    });
  }

  // Fallback label per type when a row has no explicit title (defensive only).
  function notifTypeLabel(type) {
    switch (type) {
      case "schedule_published": return "פרסום סידור";
      case "deadline_warning": return "תזכורת הגשה";
      case "admin_broadcast": return "הודעה מהמנהל";
      case "schedule_changed": return "עדכון שיבוץ";
      default: return "התראה";
    }
  }

  // Short Hebrew relative-time label ("לפני 5 דקות" / "אתמול" / a date).
  function notifTimeLabel(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (!then) return "";
    var diff = Date.now() - then;
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return "עכשיו";
    if (min < 60) return "לפני " + min + " דק׳";
    var hr = Math.floor(min / 60);
    if (hr < 24) return "לפני " + hr + " שעות";
    var day = Math.floor(hr / 24);
    if (day === 1) return "אתמול";
    if (day < 7) return "לפני " + day + " ימים";
    var d = new Date(then);
    return d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear();
  }

  function toggleNotifPanel() {
    if (notifState.open) { closeNotifPanel(); return; }
    notifState.open = true;
    if (el.notifWrap) el.notifWrap.classList.add("is-open");
    if (el.notifPanel) el.notifPanel.hidden = false;
    if (el.notifBell) el.notifBell.setAttribute("aria-expanded", "true");
    loadNotifications(); // freshest view on open
  }

  function closeNotifPanel() {
    notifState.open = false;
    if (el.notifWrap) el.notifWrap.classList.remove("is-open");
    if (el.notifPanel) el.notifPanel.hidden = true;
    if (el.notifBell) el.notifBell.setAttribute("aria-expanded", "false");
  }

  function markAllNotificationsRead() {
    // Optimistic: clear the badge immediately, then persist.
    notifState.items.forEach(function (n) { n.isRead = true; });
    notifState.unread = 0;
    renderNotifications();
    if (!state.user || state.demoMode) return;
    api("POST", "notifications/read-all").then(function () {
      loadNotifications();
    }).catch(function () { /* badge already cleared locally */ });
  }

  function onSendBroadcast(e) {
    e.preventDefault();
    if (!el.notifBroadcastMsg) return;
    var msg = el.notifBroadcastMsg.value.trim();
    if (!msg) { toast("יש להזין תוכן להודעה", false); return; }
    api("POST", "notifications/broadcast", { message: msg }).then(function (data) {
      el.notifBroadcastMsg.value = "";
      toast("ההודעה נשלחה ל-" + ((data && data.sent) || 0) + " משתלמים", true);
      loadNotifications();
    }).catch(function () { toast("שליחת ההודעה נכשלה", false); });
  }

  /* ---------------- Admin "view as" impersonation ----------------
     An admin/coordinator can preview the whole app as any other user to verify
     what that role sees and which restrictions apply. This is a client-side
     display mode only: the admin's real session token keeps driving every API
     call, but the resolved permission flags (`state.perms`) and the on-screen
     identity (`state.user`) are swapped for the target's, so the UI gates the
     exact same way it would for that user. A prominent banner stays pinned at
     the top; clicking it drops the impersonation key and restores the admin. */

  // The stored impersonation target, validated, or null when not impersonating.
  function getImpersonation() {
    var imp = storeGet(K_IMPERSONATE, null);
    if (imp && imp.id != null && imp.name && imp.role) return imp;
    return null;
  }
  // Whether the real (non-impersonated) account may manage roles — the gate for
  // both showing the impersonate buttons and honoring a stored impersonation.
  function canRealManageRoles() {
    return !!(state.realPerms && state.realPerms.canManageRoles);
  }

  // Enter the app as either the impersonated user or the real account, depending
  // on the stored key. Safe to call after every bootstrap and on start/exit.
  function enterImpersonationAware() {
    var imp = getImpersonation();
    if (imp && canRealManageRoles()) {
      // Adopt the target's role permissions and identity for the UI.
      state.perms = rolePerms(imp.role);
      enterApp({ id: imp.id, name: imp.name, email: "", role: imp.role });
    } else {
      // No impersonation (or the real account isn't allowed to) — restore the
      // genuine account and clear any stale/forged key.
      if (imp) storeRemove(K_IMPERSONATE);
      state.perms = state.realPerms || state.perms;
      enterApp(state.realUser || state.user);
    }
    renderImpersonationBanner();
  }

  // Begin viewing the app as another user (from the staff-management actions).
  function startImpersonation(userId) {
    if (!canRealManageRoles()) return;
    var u = (cache.users || []).filter(function (x) { return x.id === userId; })[0];
    if (!u) return;
    if (state.realUser && u.id === state.realUser.id) return; // can't impersonate yourself
    storeSet(K_IMPERSONATE, { id: u.id, name: u.name, role: u.role });
    enterImpersonationAware();
    toast("מצב תצוגה: צופה במערכת כ-" + u.name, true);
  }

  // Drop the impersonation and restore the admin's own view (banner click).
  function exitImpersonation() {
    if (!getImpersonation()) return;
    storeRemove(K_IMPERSONATE);
    enterImpersonationAware();
    toast("חזרת לחשבון הניהול שלך", true);
  }

  // Show/update the pinned top banner while impersonating; hide it otherwise.
  function renderImpersonationBanner() {
    var banner = el.impBanner;
    if (!banner) return;
    var imp = getImpersonation();
    if (imp && canRealManageRoles()) {
      banner.textContent = "🔍 מצב תצוגה פעיל: צפייה במערכת כ-" + imp.name + " | לחץ כאן לחזרה לניהול";
      banner.hidden = false;
      document.body.classList.add("imp-active");
    } else {
      banner.hidden = true;
      document.body.classList.remove("imp-active");
    }
  }

  /* ---------------- Offline "Demo Bypass" preview ----------------
     Netlify preview/deploy URLs (*.netlify.app) may run without a reachable
     database. When a real login then fails, the passcode "demo2026" forces a
     mock client-side ADMIN session seeded with sample data so the new user-
     management groups and the crew-reveal config can be reviewed end-to-end
     without any backend. Nothing is persisted and no request is made (api() is
     short-circuited while state.demoMode is on). */
  var DEMO_PASSCODE = "demo2026";

  function isDemoEligible() {
    try { return /(^|\.)netlify\.app$/i.test(location.hostname); } catch (e) { return false; }
  }

  function enterDemoMode() {
    hideError();
    hideNotice();
    state.demoMode = true;
    state.token = null;
    storeRemove(K_TOKEN);
    var data = buildDemoData();
    applyBootstrap(data);
    state.realUser = { id: data.user.id, name: data.user.name, email: data.user.email, role: data.user.role };
    state.realPerms = data.myPerms || defaultPerms(data.user && data.user.role);
    if (el.loginForm) el.loginForm.reset();
    enterImpersonationAware();
    toast("מצב הדגמה — נתונים לדוגמה בלבד, ללא חיבור לשרת", true);
  }

  // Bootstrap-shaped sample payload for the demo session. The user list spans
  // every user-management group (a pending account, active + graduated trainees
  // across two courses, and volunteers) so the collapsible sections all populate.
  function buildDemoData() {
    return {
      user: { id: 1, name: "מנהל הדגמה", email: "demo@local", role: "admin" },
      myPerms: defaultPerms("admin"),
      roles: [
        { id: 1, name: "admin", isSystem: true, defaultWeeklyQuota: 0, stageTargets: { stage1RequiredShifts: 10, stage2RequiredShifts: 15, stage3RequiredShifts: 20, stage4RequiredShifts: 25 }, permissions: defaultPerms("admin") },
        { id: 2, name: "viewer", isSystem: true, defaultWeeklyQuota: 3, stageTargets: { stage1RequiredShifts: 8, stage2RequiredShifts: 12, stage3RequiredShifts: 16, stage4RequiredShifts: 20 }, permissions: defaultPerms("viewer") }
      ],
      courses: ["קורס קפ״ק", "קורס פאראמדיקים א׳"],
      stations: [
        { id: 1, name: "ניידת טיפול נמרץ", shift: "morning", hours: "06:00 – 14:00" },
        { id: 2, name: "אמבולנס לבן", shift: "evening", hours: "14:00 – 22:00" },
        { id: 3, name: "ניידת לילה", shift: "night", hours: "22:00 – 06:00" }
      ],
      roster: [
        { id: 1, name: "דנה לוי" }, { id: 2, name: "אבי כהן" },
        { id: 3, name: "מאיה ברק" }, { id: 4, name: "יוסי נחום" }
      ],
      lockConfig: { enabled: false, day: 4, time: "20:00" },
      crewRevealHours: 12,
      stageTargets: { stage1RequiredShifts: 10, stage2RequiredShifts: 15, stage3RequiredShifts: 20, stage4RequiredShifts: 25 },
      myStageTargets: { stage1RequiredShifts: 10, stage2RequiredShifts: 15, stage3RequiredShifts: 20, stage4RequiredShifts: 25 },
      publishedWeeks: [],
      users: [
        { id: 11, name: "רוני אבידן", email: "roni@demo.local", role: "viewer", status: "Pending", shiftTarget: 0, shiftCount: 0, course: "", activeTrainee: true, isVolunteer: false, isIntern: false, isApprovedTutor: false, shabbatKeeper: false },
        { id: 12, name: "נועה גלר", email: "noa@demo.local", role: "viewer", status: "Approved", shiftTarget: 3, shiftCount: 5, course: "קורס קפ״ק", activeTrainee: true, isVolunteer: false, isIntern: true, isApprovedTutor: false, shabbatKeeper: true },
        { id: 13, name: "איתי שדה", email: "itai@demo.local", role: "viewer", status: "Approved", shiftTarget: 2, shiftCount: 8, course: "קורס קפ״ק", activeTrainee: false, isVolunteer: false, isIntern: true, isApprovedTutor: false, shabbatKeeper: false },
        { id: 14, name: "טל מזרחי", email: "tal@demo.local", role: "viewer", status: "Approved", shiftTarget: 4, shiftCount: 3, course: "קורס פאראמדיקים א׳", activeTrainee: true, isVolunteer: false, isIntern: false, isApprovedTutor: false, shabbatKeeper: false },
        { id: 15, name: "גיא פלד", email: "guy@demo.local", role: "viewer", status: "Approved", shiftTarget: 0, shiftCount: 0, course: "", activeTrainee: true, isVolunteer: true, isIntern: false, isApprovedTutor: true, shabbatKeeper: false },
        { id: 16, name: "שירה דרור", email: "shira@demo.local", role: "viewer", status: "Approved", shiftTarget: 0, shiftCount: 0, course: "", activeTrainee: true, isVolunteer: true, isIntern: false, isApprovedTutor: true, shabbatKeeper: false },
        { id: 1, name: "מנהל הדגמה", email: "demo@local", role: "admin", status: "Approved", shiftTarget: 0, shiftCount: 0, course: "", activeTrainee: true, isVolunteer: false, isIntern: false, isApprovedTutor: false, shabbatKeeper: false }
      ]
    };
  }

  /* ---------------- Permission helpers (dynamic RBAC) ---------------- */
  // Baseline used before the server's flags arrive, or for a role with no
  // matching definition: admins get everything, everyone else the trainee set.
  function defaultPerms(role) {
    if (role === "admin") {
      return {
        canViewSchedule: true,
        canViewDashboard: true,
        canViewMonthly: true,
        canViewEngine: true,
        canViewForms: true,
        canViewTracking: true,
        canViewPlacement: true,
        canViewTraineeView: true,
        canViewWeekly: false,
        canViewUsers: true,
        canViewStations: true,
        canViewRoster: true,
        canViewWhiteAmbulance: true,
        canEditSchedule: true,
        canFillChecklist: true,
        canManageRoles: true,
        canOverrideChecklist: true
      };
    }
    return {
      canViewSchedule: true,
      canViewDashboard: false,
      canViewMonthly: false,
      canViewEngine: false,
      canViewForms: true,
      canViewTracking: false,
      canViewPlacement: true,
      canViewTraineeView: false,
      canViewWeekly: true,
      canViewUsers: false,
      canViewStations: false,
      canViewRoster: false,
      canViewWhiteAmbulance: false,
      canEditSchedule: false,
      canFillChecklist: true,
      canManageRoles: false,
      canOverrideChecklist: false
    };
  }
  function can(flag) { return !!(state.perms && state.perms[flag]); }
  function canManageRoles() { return can("canManageRoles"); }
  function canEditSchedule() { return can("canEditSchedule"); }
  function currentUserRoleLabel() {
    return state.user ? roleOptionLabel(state.user.role) : "";
  }
  function isWhiteAmbulanceAdmin() {
    return can("canViewWhiteAmbulance");
  }
  function isPrivateDailyImportAdmin() {
    return isWhiteAmbulanceAdmin();
  }
  function isPrivateStationName(stationOrName) {
    if (stationOrName && typeof stationOrName === "object") {
      if (stationOrName.isWhiteAmbulance != null) return !!stationOrName.isWhiteAmbulance;
      return !!PRIVATE_STATION_NAMES[String(stationOrName.name || "").trim()];
    }
    return !!PRIVATE_STATION_NAMES[String(stationOrName || "").trim()];
  }
  function canSeeStationRow(stationOrName, roleOverride) {
    var role = roleOverride || (state.user && state.user.role) || "";
    var whiteStation = isPrivateStationName(stationOrName);
    if (whiteStation) {
      if (!state.isWhiteAmbulanceContext) return false;
      if (!roleOverride) return can("canViewWhiteAmbulance");
      var p = rolePerms(role);
      return !!(p && p.canViewWhiteAmbulance);
    }
    return !state.isWhiteAmbulanceContext;
  }
  function filterVisibleStations(list, roleOverride) {
    return (list || []).filter(function (s) { return canSeeStationRow(s, roleOverride); });
  }
  // "Elevated" — any non-trainee account (editor or role manager). Replaces the
  // old `role === "admin"` check across every general visibility decision.
  function isAdmin() { return canEditSchedule() || canManageRoles(); }

  // Visibility gate for slot-level mentoring-form controls.
  function canSeeNoForm() {
    if (isAdmin()) return true;
    var role = state.user && state.user.role;
    return role === "scheduler" || role === "משבץ" || role === "סדרן";
  }

  function normalizePersonName(v) {
    return String(v || "").replace(/\s+/g, " ").trim();
  }

  // Resolve free-text slot assignment to a canonical user object from cache.users.
  function findAssignedUserByName(name) {
    var target = normalizePersonName(name);
    if (!target) return null;
    var list = cache.users || [];
    for (var i = 0; i < list.length; i++) {
      if (normalizePersonName(list[i].name) === target) return list[i];
    }
    return null;
  }

  // Dynamic mentoring-form requirement on the canonical user record.
  function userRequiresMentoringForm(user) {
    if (!user) return false;
    return !!user.formRequiredPermission;
  }

  // Find the already-loaded checklist row that matches one daily-board slot.
  function findFormChecklistRow(iso, shift, slotKey) {
    var rows = cache.formRows || [];
    var source = shift && shift.isCustom ? "custom" : "schedule";
    var refId = Number(shift && shift.id) || 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.date !== iso) continue;
      if ((r.source || "schedule") !== source) continue;
      if ((Number(r.refId) || 0) !== refId) continue;
      if ((r.slot || "") !== slotKey) continue;
      return r;
    }
    return null;
  }

  // Time-bucket key for tracking rows, based on shift execution start vs now.
  // Buckets: future, <=24h, <=48h, <=72h, >72h.
  function trackingBucketKey(r) {
    var start = shiftStartDate(r.date, r.hours || stationHoursFor(r.station, r.shift), r.shift);
    if (!start) {
      var p = (r.date || "").split("-");
      if (p.length === 3) start = new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0);
    }
    if (!start) return "over3";
    var diff = Date.now() - start.getTime();
    if (diff < 0) return "future";
    if (diff <= 24 * 3600000) return "day1";
    if (diff <= 48 * 3600000) return "day2";
    if (diff <= 72 * 3600000) return "day3";
    return "over3";
  }

  // The permission set for a role NAME, from the cached definitions (falling
  // back to the safe defaults for an unknown/legacy role).
  function rolePerms(name) {
    var r = (cache.roles || []).filter(function (x) { return x.name === name; })[0];
    return (r && r.permissions) || defaultPerms(name);
  }
  // A "trainee" role is one that neither edits the schedule nor manages roles —
  // the people the assignment engine staffs and who submit availability.
  function isTraineeRole(name) {
    var p = rolePerms(name);
    return !p.canEditSchedule && !p.canManageRoles;
  }

  // Display label for a role badge / option. The built-ins get friendly Hebrew
  // labels; a custom role (already Hebrew) shows its own name.
  function roleLabel(role) {
    if (role === "admin") return "מנהל";
    if (role === "viewer") return "משתלם";
    return role;
  }
  function roleOptionLabel(role) {
    if (role === "admin") return "מנהל / Admin";
    if (role === "viewer") return "משתלם / צופה";
    return role;
  }

  /* ---------------- Tabs ---------------- */
  // Rebuild the mobile nav <select> from the currently visible tab buttons so it
  // always mirrors the same role-based visibility as the desktop tabs, then mark
  // the active option. Kept in sync on every switchTab call.
  function syncMobileNav(activeTab) {
    var sel = el.navMobileSelect;
    if (!sel) return;
    sel.innerHTML = "";
    Array.prototype.forEach.call(document.querySelectorAll(".nav-tab"), function (t) {
      if (t.hidden) return;
      if (t.getAttribute("data-tab") === "white-ambulance-parent") return;
      var opt = document.createElement("option");
      opt.value = t.getAttribute("data-tab");
      opt.textContent = t.textContent;
      if (opt.value === activeTab) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function switchTab(tab) {
    closeAssignPicker(); // never leave a floating popover behind on navigation
    closeNameMenu();
    if ((tab === "white-schedule" || tab === "white-monthly" || tab === "white-stations" || tab === "white-import") && !can("canViewWhiteAmbulance")) tab = "schedule";
    if (tab === "users" && !can("canViewUsers")) tab = "schedule";
    if (tab === "stations" && !can("canViewStations")) tab = "schedule";
    if (tab === "roster" && !can("canViewRoster")) tab = "schedule";
    if (tab === "engine" && !can("canViewEngine")) tab = "schedule";
    if (tab === "monthly" && !can("canViewMonthly")) tab = "schedule"; // monthly matrix visibility
    if (tab === "dashboard" && !can("canViewDashboard")) tab = "schedule"; // dashboard visibility
    if (tab === "weekly" && !can("canViewWeekly")) tab = "schedule";
    if (tab === "forms" && !can("canViewForms")) tab = "schedule";
    if (tab === "tracking" && !can("canViewTracking")) tab = "schedule";
    if (tab === "placement" && !can("canViewPlacement")) tab = "schedule";
    if (tab === "trainee-view" && !can("canViewTraineeView")) tab = "schedule";
    if (tab === "schedule" && !can("canViewSchedule")) {
      var fallbackOrder = [
        "dashboard", "monthly", "engine", "forms", "tracking", "placement",
        "trainee-view", "weekly", "users", "stations", "roster", "white-schedule"
      ];
      var canTab = {
        dashboard: "canViewDashboard",
        monthly: "canViewMonthly",
        engine: "canViewEngine",
        forms: "canViewForms",
        tracking: "canViewTracking",
        placement: "canViewPlacement",
        "trainee-view": "canViewTraineeView",
        weekly: "canViewWeekly",
        users: "canViewUsers",
        stations: "canViewStations",
        roster: "canViewRoster",
        "white-schedule": "canViewWhiteAmbulance"
      };
      for (var i = 0; i < fallbackOrder.length; i++) {
        if (fallbackOrder[i] === "white-schedule") {
          if (can("canViewWhiteAmbulance")) { tab = fallbackOrder[i]; break; }
        } else if (can(canTab[fallbackOrder[i]])) { tab = fallbackOrder[i]; break; }
      }
    }
    var isUsers = tab === "users";
    var isStations = tab === "stations";
    var isRoster = tab === "roster";
    var isWeekly = tab === "weekly";
    var isForms = tab === "forms";
    var isTracking = tab === "tracking";
    var isMonthly = tab === "monthly";
    var isEngine = tab === "engine";
    var isWhiteSchedule = tab === "white-schedule";
    var isWhiteMonthly = tab === "white-monthly";
    var isWhiteStations = tab === "white-stations";
    var isWhiteImport = tab === "white-import";
    var isDashboard = tab === "dashboard";
    var isPlacement = tab === "placement";
    var isTraineeView = tab === "trainee-view";
    var isSchedule = !isUsers && !isStations && !isRoster && !isWeekly && !isForms && !isTracking && !isMonthly && !isEngine && !isWhiteSchedule && !isWhiteMonthly && !isWhiteStations && !isWhiteImport && !isDashboard && !isPlacement && !isTraineeView;
    el.tabSchedule.hidden = !isSchedule;
    el.tabUsers.hidden = !isUsers;
    el.tabStations.hidden = !isStations;
    el.tabRoster.hidden = !isRoster;
    if (el.tabWeekly) el.tabWeekly.hidden = !isWeekly;
    if (el.tabForms) el.tabForms.hidden = !isForms;
    if (el.tabTracking) el.tabTracking.hidden = !isTracking;
    if (el.tabMonthly) el.tabMonthly.hidden = !isMonthly;
    if (el.tabEngine) el.tabEngine.hidden = !isEngine;
    if (el.tabWhiteSchedule) el.tabWhiteSchedule.hidden = !isWhiteSchedule;
    if (el.tabWhiteMonthly) el.tabWhiteMonthly.hidden = !isWhiteMonthly;
    if (el.tabWhiteStations) el.tabWhiteStations.hidden = !isWhiteStations;
    if (el.tabWhiteImport) el.tabWhiteImport.hidden = !isWhiteImport;
    if (el.tabDashboard) el.tabDashboard.hidden = !isDashboard;
    if (el.tabPlacement) el.tabPlacement.hidden = !isPlacement;
    if (el.tabTraineeView) el.tabTraineeView.hidden = !isTraineeView;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-tab"), function (t) {
      var tabId = t.getAttribute("data-tab");
      var active = tabId === tab;
      if (tabId === "white-ambulance-parent") active = isWhiteSchedule || isWhiteMonthly || isWhiteStations || isWhiteImport;
      t.classList.toggle("is-active", active);
    });
    syncMobileNav(tab);
    if (isUsers) { refreshUsers(); renderRolesPanel(); renderCoursesPanel(); }
    if (isStations) { renderStations(); renderLockConfig(); renderCrewRevealConfig(); renderDeadlineReminderConfig(); renderPublishConfig(); }
    if (isRoster) { renderRoster(); renderApprovedTutors(); loadManualTutors(); }
    if (isWeekly) loadWeekly();
    if (isForms) loadForms();
    if (isTracking) loadForms();
    if (isMonthly) loadMatrix();
    if (isEngine) loadEngine();
    if (isWhiteSchedule) loadWhiteAmbulancePanel();
    if (isWhiteMonthly) loadWhiteMonthly();
    if (isWhiteStations) loadWhiteStations();
    if (isWhiteImport) loadWhiteImportPanel();
    if (isDashboard) loadDashboard();
    if (isPlacement) loadPlacementNotes();
    if (isTraineeView) {
      renderTraineeViewEditControls();
      loadTraineesList();
    }
    if (isSchedule) renderTraineeProgress();

    // Keep a fresh DB query running while the admin is on the Users tab so new
    // registrations (made elsewhere, e.g. another window) appear without any
    // manual interaction. Stopped the moment the admin leaves the tab.
    if (isUsers) startUsersPolling(); else stopUsersPolling();
  }

  /* ---------------- Trainee certification-progress tracker ----------------
     A visual "where am I on the certification path" component shown at the top of
     the trainee's main (schedule) view. It plots the trainee's lifetime completed
     shifts (`shiftCount`) against the admin-defined per-stage shift targets:
     stages whose requirement is met read as completed, the first unmet stage is
     highlighted with live progress toward it, and later stages are upcoming. Staff
     accounts (editors / role managers) have no certification path, so it stays
     hidden. */

  // The logged-in trainee's lifetime tally of COMPLETED shifts. Comes straight
  // from the bootstrap user payload; when previewing another account via
  // impersonation (which carries no count), fall back to that user's cached
  // roster record so an admin still sees a representative progress bar.
  function currentTraineeShiftCount() {
    var n = state.user ? state.user.shiftCount : undefined;
    if (n === undefined || n === null) {
      var u = (cache.users || []).filter(function (x) { return state.user && x.id === state.user.id; })[0];
      n = u ? u.shiftCount : 0;
    }
    n = Number(n);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // Place a trainee on the certification path from their total completed shifts
  // and the admin-defined per-stage targets. Each target is the count needed to
  // CLEAR one stage (not cumulative), so walk the stages consuming shifts: a stage
  // is done once its full requirement is met, and the first unmet stage is the
  // current one. Returns everything the tracker needs to render — how many stages
  // are cleared, the active stage index, progress into it, and the overall fill.
  function computeStageProgress(total, targets) {
    var doneCount = 0;   // fully cleared stages
    var consumed = 0;    // shifts accounted for by cleared stages
    for (var i = 0; i < targets.length; i++) {
      var need = targets[i];
      if (need <= 0) { doneCount++; continue; }        // a zero-requirement stage clears instantly
      if (total - consumed >= need) { consumed += need; doneCount++; }
      else break;
    }
    var allDone = doneCount >= targets.length;
    var curIdx = allDone ? -1 : doneCount;             // -1 = every stage cleared
    var need = 0, into = 0, remaining = 0, stagePct = 0;
    if (!allDone) {
      need = targets[curIdx];
      into = Math.max(0, total - consumed);            // shifts banked toward the current stage
      remaining = Math.max(0, need - into);
      stagePct = need > 0 ? Math.min(100, Math.round((into / need) * 100)) : 100;
    }
    var overallPct = allDone
      ? 100
      : Math.round(((doneCount + (need > 0 ? into / need : 0)) / targets.length) * 100);
    overallPct = Math.max(0, Math.min(100, overallPct));
    return { total: total, doneCount: doneCount, allDone: allDone, curIdx: curIdx, need: need, into: into, remaining: remaining, stagePct: stagePct, overallPct: overallPct };
  }

  function renderTraineeProgress() {
    var host = el.traineeProgress;
    if (!host) return;
    // Only trainees have a certification path; hide it entirely for staff.
    if (isAdmin()) { host.hidden = true; host.innerHTML = ""; return; }

    var targets = myStageTargetList();
    var total = currentTraineeShiftCount();
    var p = computeStageProgress(total, targets);

    host.hidden = false;
    host.innerHTML = "";

    var head = document.createElement("div");
    head.className = "trainee-progress-head";
    var title = document.createElement("h2");
    title.className = "trainee-progress-title";
    title.textContent = "סטטוס התקדמות בהסמכה";
    head.appendChild(title);
    var sub = document.createElement("p");
    sub.className = "trainee-progress-sub";
    if (p.allDone) {
      sub.textContent = "כל הכבוד! השלמת את כל שלבי ההסמכה · סה״כ " + total + " משמרות שהושלמו";
    } else {
      sub.textContent = "השלב הנוכחי שלך: " + PROGRESS_STAGES[p.curIdx].desc +
        " · שלב " + (p.curIdx + 1) + " מתוך " + PROGRESS_STAGES.length +
        " · הושלמו " + total + " משמרות · נותרו " + p.remaining + " להשלמת השלב";
    }
    head.appendChild(sub);
    host.appendChild(head);

    // A continuous fill bar spanning the whole path: cleared stages plus the
    // fractional progress into the current one, as a share of all four stages.
    // An explicit percentage label sits beside the bar so the trainee sees their
    // exact completion (e.g. "65%") rather than having to read it off the fill.
    var barRow = document.createElement("div");
    barRow.className = "progress-bar-row";
    var bar = document.createElement("div");
    bar.className = "progress-bar";
    var fill = document.createElement("div");
    fill.className = "progress-bar-fill";
    fill.style.inlineSize = p.overallPct + "%";
    bar.appendChild(fill);
    barRow.appendChild(bar);
    var pct = document.createElement("span");
    pct.className = "progress-bar-pct";
    pct.textContent = p.overallPct + "%";
    barRow.appendChild(pct);
    host.appendChild(barRow);

    var ol = document.createElement("ol");
    ol.className = "progress-steps";
    PROGRESS_STAGES.forEach(function (st, idx) {
      var li = document.createElement("li");
      li.className = "progress-step";
      var done = idx < p.doneCount;
      var isCurrent = !p.allDone && idx === p.curIdx;
      if (done) li.classList.add("is-done");
      else if (isCurrent) li.classList.add("is-current");
      else li.classList.add("is-upcoming");
      if (isCurrent) li.setAttribute("aria-current", "step");

      var dot = document.createElement("span");
      dot.className = "progress-step-dot";
      dot.textContent = done ? "✓" : String(idx + 1);
      li.appendChild(dot);

      var body = document.createElement("span");
      body.className = "progress-step-body";
      var name = document.createElement("span");
      name.className = "progress-step-name";
      name.textContent = st.short;
      body.appendChild(name);
      var desc = document.createElement("span");
      desc.className = "progress-step-desc";
      desc.textContent = st.desc;
      body.appendChild(desc);
      // A count line making the admin-configured target explicit: how many shifts
      // the stage needs, and — for the active stage — how many are banked so far.
      var count = document.createElement("span");
      count.className = "progress-step-count";
      var need = targets[idx];
      if (done) count.textContent = "הושלם · " + need + " משמרות";
      else if (isCurrent) count.textContent = p.into + " / " + need + " משמרות";
      else count.textContent = "נדרשות " + need + " משמרות";
      body.appendChild(count);
      li.appendChild(body);

      ol.appendChild(li);
    });
    host.appendChild(ol);
  }

  /* ---------------- User management ---------------- */
  function refreshUsers() {
    if (!canManageRoles()) return Promise.resolve();
    // The quota is weekly, so the table compares each trainee against the CURRENT
    // week's count rather than a monthly total.
    return Promise.all([
      api("GET", "users"),
      api("GET", contextQuery("schedules?counts=1&week=" + weekStartIso(todayIso()))).catch(function () { return { counts: {} }; })
    ]).then(function (res) {
      cache.users = res[0] || [];
      cache.weekCounts = (res[1] && res[1].counts) || {};
      renderUsers();
    }).catch(function () { renderUsers(); });
  }

  // Re-pull the per-trainee WEEK shift counts for the relevant week, then refresh
  // the users table if it's open. Called after an assignment changes so the
  // counter reflects placements made on the schedule screen in real time. The
  // relevant week is the one being edited (the open day), else the current week.
  function refreshShiftCounts() {
    if (!isAdmin()) return Promise.resolve();
    return refreshWeekCounts(state.selectedDate || todayIso()).then(function () {
      if (el.tabUsers && !el.tabUsers.hidden) renderUsers();
    });
  }

  // Load the per-trainee shift counts for the ISO week containing `iso` into
  // cache.weekCounts. Used by both the users table and the smart pickers, which
  // measure each trainee against their WEEKLY quota.
  function refreshWeekCounts(iso) {
    if (!isAdmin()) return Promise.resolve();
    return api("GET", contextQuery("schedules?counts=1&week=" + weekStartIso(iso || todayIso()))).then(function (d) {
      cache.weekCounts = (d && d.counts) || {};
    }).catch(function () { /* leave the last known counts in place */ });
  }

  /* ---------------- Personal shift target (per trainee) ---------------- */
  // Each trainee carries their own WEEKLY target on the user record. 0 means no
  // target has been set yet, so the badge shows a plain count without pass/fail.
  function userTarget(u) {
    var n = u && Number(u.shiftTarget);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // Persist a trainee's personal target. Optimistically mirrors it into the
  // cached user so every badge (table + smart picker) recolours immediately.
  function saveUserTarget(userId, value) {
    var target = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    api("PATCH", "users/" + userId, { shiftTarget: target }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.shiftTarget = target; });
      renderUsers(); // recolour this trainee's progress badge against the new target
      toast("יעד המשמרות נשמר", true);
    }).catch(function () { toast("היעד לא נשמר", false); });
  }

  // Persist an admin override of a trainee's completed-shift counter, mirroring the
  // new value into the cached user so the input keeps it after a re-render.
  function saveUserShiftCount(userId, value) {
    var count = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    api("PATCH", "users/" + userId, { shiftCount: count }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.shiftCount = count; });
      toast("מונה המשמרות עודכן", true);
    }).catch(function () { toast("מונה המשמרות לא נשמר", false); renderUsers(); });
  }

  // A coloured fraction badge: assignments this week / the trainee's personal
  // weekly target. Green once they meet or beat their target, orange while below.
  function buildShiftBadge(u) {
    var count = cache.weekCounts[u.name] || 0;
    var target = userTarget(u);
    var badge = document.createElement("span");
    badge.className = "quota-badge";
    if (target > 0) {
      var met = count >= target;
      badge.classList.add(met ? "ok" : "low");
      badge.textContent = count + " / " + target + " משמרות";
    } else {
      // No personal target set yet — show the raw count without a pass/fail colour.
      badge.classList.add("neutral");
      badge.textContent = count + " משמרות";
    }
    return badge;
  }

  // Poll the live `users` table while the Users tab is visible. Each tick is the
  // same DB query as a manual tab click, so pending registrations surface on
  // their own. Skipped while the document is hidden (the focus/visibility
  // handlers already re-pull on return), and cleared on tab change / logout.
  var USERS_POLL_MS = 15000;
  function startUsersPolling() {
    stopUsersPolling();
    if (!canManageRoles()) return;
    state.usersPoll = window.setInterval(function () {
      if (document.hidden) return;
      if (!canManageRoles() || !el.tabUsers || el.tabUsers.hidden) { stopUsersPolling(); return; }
      refreshUsers();
    }, USERS_POLL_MS);
  }
  function stopUsersPolling() {
    if (state.usersPoll) { window.clearInterval(state.usersPoll); state.usersPoll = null; }
  }

  /* ---------------- User management — structured, collapsible groups ----------------
     The flat accounts table is split into collapsible categories rendered into
     #users-sections: (1) pending approval — always first; (2) active trainees,
     sub-grouped by training course, each row carrying a course dropdown and a
     "משתלם פעיל" switch; (3) volunteer paramedics / external staff with a quick
     login-access toggle; (4) a managers & staff catch-all so no account is ever
     hidden. Every original row action (אשר/חסום/ערוך שם/מחק) is preserved. */

  // Course catalog for the trainee grouping + inline dropdown. The list is now
  // managed dynamically by admins and delivered from the server (cache.courses);
  // these defaults are only a fallback for the brief moment before the first
  // bootstrap resolves. A saved course not in the active list is still preserved
  // (an extra <option> is appended for it in the row dropdown).
  var DEFAULT_COURSES = [
    "קורס קפ״ק",
    "קורס פאראמדיקים א׳",
    "קורס פאראמדיקים ב׳",
    "קורס חובשים"
  ];
  // The active, admin-managed course list. Falls back to the built-in defaults
  // only when the cache has not been populated yet.
  function courseList() {
    var list = (cache && cache.courses) || [];
    return list.length ? list : DEFAULT_COURSES;
  }
  var COURSE_UNASSIGNED = "ללא שיוך לקורס";

  // Open/closed state for the accordion sections, kept across the 15s polling
  // re-render so a section the admin opened doesn't snap shut. Keyed by section
  // id and by "course:<name>" for the per-course sub-sections. Persisted to
  // localStorage so an admin's open/closed choices survive a page refresh;
  // sections default to closed when no preference has been saved.
  var USERS_OPEN_KEY = "sss_users_open";
  var usersOpen = storeGet(USERS_OPEN_KEY, {}) || {};
  function sectionOpen(key, dflt) {
    return Object.prototype.hasOwnProperty.call(usersOpen, key) ? !!usersOpen[key] : !!dflt;
  }

  function uMuted() {
    var s = document.createElement("span");
    s.className = "muted"; s.textContent = "—";
    return s;
  }
  function usersEmptyNote(text) {
    var p = document.createElement("p");
    p.className = "users-empty"; p.textContent = text;
    return p;
  }

  function uCellName(u, isSelf) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "שם");
    td.textContent = u.name;
    if (isSelf) {
      var you = document.createElement("span");
      you.className = "you-tag"; you.textContent = "(אני)";
      td.appendChild(you);
    }
    return td;
  }
  function uCellEmail(u) {
    var td = document.createElement("td");
    td.className = "u-email";
    td.setAttribute("data-label", "דוא״ל");
    var addr = document.createElement("span");
    addr.className = "u-email-addr";
    addr.textContent = u.email;
    td.appendChild(addr);
    // At-a-glance email-verification state (admin overrule lives in the actions).
    var pill = document.createElement("span");
    pill.className = "verify-pill " + (u.isVerified ? "is-verified" : "is-unverified");
    pill.textContent = u.isVerified ? "דוא״ל מאומת" : "דוא״ל לא מאומת";
    td.appendChild(pill);
    return td;
  }
  function uCellStatus(u) {
    var isApproved = (u.status || "Approved") === "Approved";
    var td = document.createElement("td");
    td.setAttribute("data-label", "סטטוס");
    var b = document.createElement("span");
    b.className = "status-badge " + (isApproved ? "approved" : "pending");
    b.textContent = isApproved ? "מאושר" : "ממתין לאישור";
    td.appendChild(b);
    return td;
  }
  function buildRoleSelect(u) {
    var select = document.createElement("select");
    select.setAttribute("aria-label", "תפקיד עבור " + u.name);
    // Populate from the dynamic role definitions so any custom role (e.g.
    // "סדרן", "מתנדב") an admin created appears here.
    var roleList = cache.roles || [];
    var hasCurrent = false;
    roleList.forEach(function (role) {
      var o = document.createElement("option");
      o.value = role.name; o.textContent = roleOptionLabel(role.name);
      if (u.role === role.name) { o.selected = true; hasCurrent = true; }
      select.appendChild(o);
    });
    // A legacy role no longer in the list still needs to show as selected.
    if (!hasCurrent) {
      var legacy = document.createElement("option");
      legacy.value = u.role; legacy.textContent = roleOptionLabel(u.role);
      legacy.selected = true;
      select.appendChild(legacy);
    }
    (function (userId) {
      select.addEventListener("change", function () { changeUserRole(userId, select.value); });
    })(u.id);
    return select;
  }
  function uCellRole(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "תפקיד");
    if ((u.status || "Approved") === "Approved") td.appendChild(buildRoleSelect(u));
    else td.appendChild(uMuted());
    return td;
  }
  // Inline training-course dropdown for a trainee row. Persists immediately.
  function uCellCourse(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "קורס");
    var select = document.createElement("select");
    select.className = "course-select";
    select.setAttribute("aria-label", "קורס עבור " + u.name);
    var cur = (u.course || "").trim();
    var optNone = document.createElement("option");
    optNone.value = ""; optNone.textContent = COURSE_UNASSIGNED;
    if (!cur) optNone.selected = true;
    select.appendChild(optNone);
    var seen = {};
    courseList().forEach(function (c) {
      seen[c] = true;
      var o = document.createElement("option");
      o.value = c; o.textContent = c;
      if (cur === c) o.selected = true;
      select.appendChild(o);
    });
    if (cur && !seen[cur]) {
      var oc = document.createElement("option");
      oc.value = cur; oc.textContent = cur; oc.selected = true;
      select.appendChild(oc);
    }
    (function (userId) {
      select.addEventListener("change", function () { saveUserCourse(userId, select.value); });
    })(u.id);
    td.appendChild(select);
    return td;
  }
  // "שלב הסמכה" dropdown for a trainee row. Drives the auto-assign supervision gate
  // (stages 1–2 require an approved tutor on the shift). Persists immediately.
  function uCellStage(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "שלב הסמכה");
    var select = document.createElement("select");
    select.className = "stage-select";
    select.setAttribute("aria-label", "שלב הסמכה עבור " + u.name);
    var cur = (u.traineeStage || "");
    TRAINEE_STAGES.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s.key; o.textContent = s.label;
      if (cur === s.key) o.selected = true;
      select.appendChild(o);
    });
    (function (userId) {
      select.addEventListener("change", function () { saveUserStage(userId, select.value); });
    })(u.id);
    td.appendChild(select);
    return td;
  }
  // "יעדי שלבים (1-4)" — per-user custom certification ladder for a NON-standard
  // trainee. A "מסלול מותאם אישית" switch unlocks four numeric inputs, one per stage,
  // letting an admin hand-set the completed-shift target for each stage instead of
  // inheriting the trainee's role/global ladder. While the switch is off the inputs
  // are disabled and show the role defaults (for reference); flipping it on unlocks
  // them and any edit persists immediately. A saved value of 0 (or a blank) means
  // "leave this one stage on the standard target".
  function uCellCustomStages(u) {
    var td = document.createElement("td");
    td.className = "custom-stage-cell";
    td.setAttribute("data-label", "יעדי שלבים (1-4)");
    var wrap = document.createElement("div");
    wrap.className = "custom-stage-wrap";

    var on = !!u.customStageTargets;

    // The role/global fallback ladder, shown greyed-out until the custom track is on.
    var roleDefaults = roleStageTargetList(u.role);
    var stored = [u.stage1Target, u.stage2Target, u.stage3Target, u.stage4Target];

    // Enable switch.
    var lbl = document.createElement("label");
    lbl.className = "switch custom-stage-toggle";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = on;
    box.setAttribute("aria-label", "מסלול מותאם אישית — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (on ? " is-on" : " is-off");
    txt.textContent = on ? "מותאם" : "רגיל";
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    wrap.appendChild(lbl);

    // Four per-stage numeric inputs.
    var inputsWrap = document.createElement("div");
    inputsWrap.className = "role-stage-inputs" + (on ? "" : " is-locked");
    var inputs = [];
    [0, 1, 2, 3].forEach(function (idx) {
      var field = document.createElement("label");
      field.className = "role-stage-input";
      var tag = document.createElement("span");
      tag.className = "role-stage-tag";
      tag.textContent = String(idx + 1);
      field.appendChild(tag);
      var input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.inputMode = "numeric";
      input.dir = "ltr";
      input.className = "target-input role-stage-target";
      // Show the stored override when set; otherwise the role default as a hint.
      var val = Number(stored[idx]);
      input.value = String(val > 0 ? val : roleDefaults[idx]);
      input.disabled = !on;
      input.setAttribute("aria-label", "יעד שלב " + (idx + 1) + " עבור " + u.name);
      field.appendChild(input);
      inputsWrap.appendChild(field);
      inputs.push(input);
    });
    wrap.appendChild(inputsWrap);

    var collect = function () {
      return {
        stage1Target: normalizeStageTarget(inputs[0].value, 0),
        stage2Target: normalizeStageTarget(inputs[1].value, 0),
        stage3Target: normalizeStageTarget(inputs[2].value, 0),
        stage4Target: normalizeStageTarget(inputs[3].value, 0)
      };
    };

    (function (userId) {
      // Toggling the track persists the flag together with whatever is currently in
      // the inputs, and locks/unlocks them in place (no full re-render, so focus and
      // scroll position are preserved while an admin tunes a profile).
      box.addEventListener("change", function () {
        var enabled = box.checked;
        inputs.forEach(function (inp) { inp.disabled = !enabled; });
        inputsWrap.classList.toggle("is-locked", !enabled);
        txt.textContent = enabled ? "מותאם" : "רגיל";
        txt.className = "switch-text" + (enabled ? " is-on" : " is-off");
        var payload = { customStageTargets: enabled };
        if (enabled) Object.assign(payload, collect());
        saveUserCustomStages(userId, payload);
      });
      // Editing a target while the track is on persists all four at once.
      inputs.forEach(function (input) {
        input.addEventListener("change", function () {
          if (!box.checked) return;
          saveUserCustomStages(userId, collect());
        });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        });
      });
    })(u.id);

    td.appendChild(wrap);
    return td;
  }
  // "משתלם פעיל" switch. Unchecked → graduated/released ("סיים/השתחרר"); the
  // server then excludes the trainee from the auto-assignment quota engine.
  function uCellActive(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "משתלם פעיל");
    var active = u.activeTrainee !== false;
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = active;
    box.setAttribute("aria-label", "משתלם פעיל — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (active ? " is-on" : " is-off");
    txt.textContent = active ? "פעיל" : "סיים/השתחרר";
    (function (userId) {
      box.addEventListener("change", function () { toggleActiveTrainee(userId, box.checked); });
    })(u.id);
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }

  // "נדרש טופס חניכה" switch. This is a manager-controlled, per-user flag that
  // decides whether this assignee participates in form-tracking/checklist flows.
  function uCellFormRequired(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "נדרש טופס חניכה");
    var on = !!u.formRequiredPermission;
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = on;
    box.setAttribute("aria-label", "נדרש טופס חניכה — " + u.name);
    var track = document.createElement("span");
    track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (on ? " is-on" : " is-off");
    txt.textContent = on ? "נדרש" : "לא";
    (function (userId) {
      box.addEventListener("change", function () { saveFormRequiredPermission(userId, box.checked, txt); });
    })(u.id);
    lbl.appendChild(box);
    lbl.appendChild(track);
    lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }

  /* ---------------- Intern flag ("סטאז'ר") ----------------
     A trainee's "סטאז'ר" flag is a single manager-controlled toggle, ORTHOGONAL
     to their access role. The auto-assign engine pairs any available intern into
     מלווה א׳ of a shift that already has an "טיוטור מאושר" (Approved Tutor, set in
     the "ניהול סגל ורשימות" tab) on its crew, and never auto-pairs an intern onto
     a shift without an approved tutor present. */

  // Inline "סטאז'ר" toggle for a trainee row. Persists immediately; no full
  // re-render so the switch stays responsive while editing.
  function uCellIntern(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "סטאז'ר");
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = !!u.isIntern;
    box.setAttribute("aria-label", "סטאז'ר — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (u.isIntern ? " is-on" : " is-off");
    txt.textContent = u.isIntern ? "סטאז'ר" : "לא";
    (function (userId) {
      box.addEventListener("change", function () { saveIntern(userId, box.checked, txt); });
    })(u.id);
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }

  /* ---------------- Shabbat keeper flag ("שומר שבת") ----------------
     A trainee marked "שומר שבת" never works on Shabbat. The auto-assign engine
     treats every Friday-evening and all Saturday shifts as hard-unavailable for
     them (like a 'cannot' preference), so they are never auto-placed into a
     Shabbat slot. Manager-controlled, orthogonal to their access role. */
  function uCellShabbat(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "שומר שבת");
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = !!u.shabbatKeeper;
    box.setAttribute("aria-label", "שומר שבת — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (u.shabbatKeeper ? " is-on" : " is-off");
    txt.textContent = u.shabbatKeeper ? "שומר שבת" : "לא";
    (function (userId) {
      box.addEventListener("change", function () { saveShabbat(userId, box.checked, txt); });
    })(u.id);
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }

  /* ---------------- Night-shift restriction ("לא זמין למשמרות לילה") ----------------
     A trainee marked here may not work night ("לילה") shifts. The auto-assign
     engine treats every night slot as hard-unavailable for them (like a 'cannot'
     preference) and the availability API rejects their night requests, so they are
     never placed on — nor can submit — a night shift. Manager-controlled,
     orthogonal to their access role. */
  function uCellRestrictNight(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "ללא לילות");
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = !!u.restrictNightShifts;
    box.setAttribute("aria-label", "לא זמין למשמרות לילה — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (u.restrictNightShifts ? " is-on" : " is-off");
    txt.textContent = u.restrictNightShifts ? "ללא לילות" : "לא";
    (function (userId) {
      box.addEventListener("change", function () { saveRestrictNight(userId, box.checked, txt); });
    })(u.id);
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }
  /* ---------------- Weekend restriction ("ללא שישי+שבת") ----------------
     A trainee marked here may not work any Friday or Saturday shift. The
     shift-request form auto-locks every Friday/Saturday slot to "לא זמין", the
     availability API rejects any weekend request, and the auto-assign engine treats
     every Fri/Sat slot as hard-unavailable. Manager-controlled, orthogonal to their
     access role. */
  function uCellRestrictWeekend(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "ללא שישי+שבת");
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = !!u.restrictWeekendShifts;
    box.setAttribute("aria-label", "ללא שישי+שבת — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (u.restrictWeekendShifts ? " is-on" : " is-off");
    txt.textContent = u.restrictWeekendShifts ? "ללא שישי+שבת" : "לא";
    (function (userId) {
      box.addEventListener("change", function () { saveRestrictWeekend(userId, box.checked, txt); });
    })(u.id);
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }
  function uCellAccess(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "גישה למערכת");
    var approved = (u.status || "Approved") === "Approved";
    var isSelf = state.user && u.id === state.user.id;
    var lbl = document.createElement("label");
    lbl.className = "switch";
    var box = document.createElement("input");
    box.type = "checkbox"; box.checked = approved; box.disabled = isSelf;
    box.setAttribute("aria-label", "גישת התחברות — " + u.name);
    var track = document.createElement("span"); track.className = "switch-track";
    var txt = document.createElement("span");
    txt.className = "switch-text" + (approved ? " is-on" : " is-off");
    txt.textContent = approved ? "גישה מלאה" : "ללא גישה";
    (function (userId) {
      box.addEventListener("change", function () { setUserStatus(userId, box.checked ? "Approved" : "Pending"); });
    })(u.id);
    lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
    td.appendChild(lbl);
    return td;
  }
  function uCellTarget(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "יעד שבועי");
    if ((u.status || "Approved") === "Approved" && isTraineeRole(u.role)) {
      var input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.step = "1";
      input.inputMode = "numeric"; input.dir = "ltr";
      input.className = "target-input";
      input.value = String(userTarget(u));
      input.setAttribute("aria-label", "יעד משמרות עבור " + u.name);
      (function (userId, inp) {
        var commit = function () {
          var v = parseInt(inp.value, 10);
          if (!Number.isFinite(v) || v < 0) v = 0;
          inp.value = String(v);
          saveUserTarget(userId, v);
        };
        inp.addEventListener("change", commit);
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      })(u.id, input);
      td.appendChild(input);
    } else td.appendChild(uMuted());
    return td;
  }
  function uCellShifts(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "משמרות (השבוע)");
    if ((u.status || "Approved") === "Approved" && isTraineeRole(u.role)) td.appendChild(buildShiftBadge(u));
    else td.appendChild(uMuted());
    return td;
  }
  // Lifetime completed-shift counter. Auto-maintained by the server as evaluation
  // forms are ticked "בוצע", and exposed here as an editable number so an admin
  // can override the tally to fix any mismatch. Persists on change / Enter.
  function uCellShiftCount(u) {
    var td = document.createElement("td");
    td.setAttribute("data-label", "מונה משמרות");
    if ((u.status || "Approved") === "Approved" && isTraineeRole(u.role)) {
      var input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.step = "1";
      input.inputMode = "numeric"; input.dir = "ltr";
      input.className = "target-input shift-count-input";
      var cur = Number(u.shiftCount);
      input.value = String(Number.isFinite(cur) && cur > 0 ? Math.floor(cur) : 0);
      input.setAttribute("aria-label", "מונה משמרות שבוצעו עבור " + u.name);
      input.title = "מספר המשמרות שבוצעו — מתעדכן אוטומטית עם סימון טופס כ\"בוצע\", וניתן לעריכה ידנית";
      (function (userId, inp) {
        var commit = function () {
          var v = parseInt(inp.value, 10);
          if (!Number.isFinite(v) || v < 0) v = 0;
          inp.value = String(v);
          saveUserShiftCount(userId, v);
        };
        inp.addEventListener("change", commit);
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      })(u.id, input);
      td.appendChild(input);
    } else td.appendChild(uMuted());
    return td;
  }
  // The full original action set (preserved verbatim), now collapsed behind a
  // single compact "פעולות" trigger that opens a floating dropdown menu. The
  // menu itself lives on <body> (fixed-positioned) so the account table's
  // clipped overflow can't cut it off and it never expands the row height.
  function uCellActions(u, isSelf) {
    var isApproved = (u.status || "Approved") === "Approved";
    var td = document.createElement("td");
    td.setAttribute("data-label", "פעולות");

    // Each entry: { label, kind (colour hint), disabled, run }. Only the ones
    // relevant to this account are pushed, mirroring the original conditions.
    var items = [];
    items.push({ label: "אשר גישה", kind: "ok", disabled: isApproved, run: function () { setUserStatus(u.id, "Approved"); } });
    items.push({ label: "חסום גישה", kind: "danger", disabled: !isApproved || isSelf, run: function () { setUserStatus(u.id, "Pending"); } });
    items.push({ label: "ערוך שם", kind: "brand", run: function () { editUserName(u.id, u.name); } });
    items.push({ label: "מחק חשבון", kind: "danger", run: function () { deleteUser(u.id); } });

    // "View as" — admins/coordinators only, on other approved accounts. Opens
    // the app exactly as that user sees it (see startImpersonation).
    if (isApproved && !isSelf && canRealManageRoles()) {
      items.push({ label: "התחבר כמשתמש", kind: "brand", run: function () { startImpersonation(u.id); } });
    }

    // Move into / out of the "פראמדיקים / מתנדבים" group (approved accounts only).
    if (isApproved) {
      items.push({
        label: u.isVolunteer ? "החזר לרשימה הרגילה" : "סמן כמתנדב",
        kind: "brand",
        run: function () { toggleVolunteer(u.id, !u.isVolunteer); }
      });
    }

    // Manual email-verification overrule (admin): flip is_verified for any user,
    // even one who never clicked the link in their verification email.
    items.push({
      label: u.isVerified ? "בטל אימות דוא״ל" : "אמת דוא״ל ידנית",
      kind: u.isVerified ? "danger" : "ok",
      run: function () { toggleVerified(u.id, !u.isVerified); }
    });

    var wrap = document.createElement("div");
    wrap.className = "actions-menu-wrap";

    // Pending (unapproved) accounts get a visible one-click "resend activation
    // email" button right in the row, next to the actions menu — the common case
    // for a new registration that never received or clicked its verification mail.
    // Admin-only surface (the whole users tab is), and it hits the admin-gated
    // /api/users/:id/resend-verification endpoint, never the generic mail sender.
    if (!isApproved) {
      wrap.appendChild(buildResendButton(u));
    }

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "btn-xs actions-menu-btn";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    var tlabel = document.createElement("span");
    tlabel.textContent = "פעולות";
    trigger.appendChild(tlabel);
    var chev = document.createElement("span");
    chev.className = "actions-menu-chev";
    chev.setAttribute("aria-hidden", "true");
    chev.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
    trigger.appendChild(chev);
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      openActionsMenu(trigger, items);
    });

    wrap.appendChild(trigger);
    td.appendChild(wrap);
    return td;
  }

  // Compact "שליחה מחדש" (resend activation email) control for a pending account.
  // Inline SVG mail icon + label (no emoji, per house style). Clicking POSTs to the
  // admin-gated resend endpoint and briefly flips the button into a success state
  // ("נשלח מחדש בהצלחה") so the admin gets immediate feedback without a re-render.
  function buildResendButton(u) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-xs resend-btn";
    btn.title = "שליחת מייל האימות/ההפעלה מחדש למשתמש זה";
    btn.setAttribute("aria-label", "שליחת מייל האימות מחדש אל " + u.name);
    btn.innerHTML =
      '<span class="resend-ic" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"></path><path d="M4 6l8 6 8-6"></path></svg></span>' +
      '<span class="resend-label">שליחה מחדש</span>';
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      resendVerification(u.id, btn);
    });
    return btn;
  }

  // Resend the account activation / verification email for a pending user. Guards
  // against double-clicks while in flight, then shows a transient success ("נשלח
  // מחדש בהצלחה") or a failure state on the button itself, plus a toast.
  function resendVerification(userId, btn) {
    if (btn && btn.dataset.busy === "1") return;
    if (btn) {
      btn.dataset.busy = "1";
      btn.disabled = true;
      btn.classList.add("is-sending");
    }
    api("POST", "users/" + userId + "/resend-verification", {}).then(function () {
      toast("מייל האימות נשלח מחדש בהצלחה", true);
      if (btn) {
        btn.classList.remove("is-sending");
        btn.classList.add("is-sent");
        var lbl = btn.querySelector(".resend-label");
        if (lbl) lbl.textContent = "נשלח מחדש בהצלחה";
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.classList.remove("is-sent");
          btn.disabled = false;
          btn.dataset.busy = "";
          var l = btn.querySelector(".resend-label");
          if (l) l.textContent = "שליחה מחדש";
        }, 2600);
      }
    }).catch(function (err) {
      var msg = err && err.status === 409 ? "החשבון כבר מאומת" : "שליחת המייל נכשלה";
      toast(msg, false);
      if (btn) {
        btn.classList.remove("is-sending");
        btn.disabled = false;
        btn.dataset.busy = "";
      }
    });
  }

  // Close any open actions dropdown, tearing down its listeners and the
  // body-level menu node. Mirrors the closeNameMenu idiom.
  function closeActionsMenu() {
    var m = state.actionsMenu;
    if (!m) return;
    document.removeEventListener("click", m.onDoc, true);
    window.removeEventListener("scroll", m.onScroll, true);
    window.removeEventListener("resize", m.onScroll, true);
    document.removeEventListener("keydown", m.onKey, true);
    if (m.trigger) m.trigger.setAttribute("aria-expanded", "false");
    if (m.pop && m.pop.parentNode) m.pop.parentNode.removeChild(m.pop);
    state.actionsMenu = null;
  }

  // Anchor the floating menu to the trigger. RTL: align the menu's right edge
  // with the trigger's right edge, then clamp inside the viewport.
  function positionActionsMenu() {
    var m = state.actionsMenu;
    if (!m) return;
    var r = m.trigger.getBoundingClientRect();
    var w = m.pop.offsetWidth || 200;
    var left = r.right - w;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    if (left < 8) left = 8;
    m.pop.style.left = left + "px";
    // Flip above the trigger when there isn't room below it.
    var h = m.pop.offsetHeight || 0;
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - 6 - h > 8) top = r.top - 6 - h;
    m.pop.style.top = top + "px";
  }

  function openActionsMenu(trigger, items) {
    var wasOpen = state.actionsMenu && state.actionsMenu.trigger === trigger;
    closeActionsMenu();
    if (wasOpen) return; // a second click on the same trigger toggles it closed

    var pop = document.createElement("div");
    pop.className = "actions-menu";
    pop.setAttribute("role", "menu");
    items.forEach(function (item) {
      var opt = document.createElement("button");
      opt.type = "button";
      opt.setAttribute("role", "menuitem");
      opt.className = "actions-menu-item" + (item.kind ? (" is-" + item.kind) : "");
      opt.textContent = item.label; // static labels, but keep it injection-safe
      if (item.disabled) opt.disabled = true;
      else opt.addEventListener("click", function () {
        closeActionsMenu();
        item.run();
      });
      pop.appendChild(opt);
    });
    document.body.appendChild(pop);

    var onDoc = function (e) {
      if (pop.contains(e.target) || trigger.contains(e.target)) return;
      closeActionsMenu();
    };
    var onScroll = function () { positionActionsMenu(); };
    var onKey = function (e) { if (e.key === "Escape") closeActionsMenu(); };
    document.addEventListener("click", onDoc, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    document.addEventListener("keydown", onKey, true);
    trigger.setAttribute("aria-expanded", "true");
    state.actionsMenu = { trigger: trigger, pop: pop, onDoc: onDoc, onScroll: onScroll, onKey: onKey };

    positionActionsMenu();
  }

  // Build a <table> for a group with the given header labels and a per-user
  // row builder.
  function buildUsersTable(headers, list, rowFn) {
    var table = document.createElement("table");
    table.className = "users-table users-acct-table";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    headers.forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      // Keep the multi-word stage-target header on one line (see .th-stage-target).
      if (h.indexOf("יעדי שלבים") === 0) th.className = "th-stage-target";
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    list.forEach(function (u) { tbody.appendChild(rowFn(u)); });
    table.appendChild(tbody);
    return table;
  }

  // Build a collapsible accordion section whose open state persists in usersOpen.
  function buildUserSection(key, title, subtitle, count, defaultOpen, bodyNodes, extraClass) {
    var open = sectionOpen(key, defaultOpen);
    var sec = document.createElement("section");
    sec.className = "user-group" + (open ? " is-open" : "") + (extraClass ? (" " + extraClass) : "");

    var head = document.createElement("button");
    head.type = "button";
    head.className = "user-group-head";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    var caret = document.createElement("span");
    caret.className = "user-group-caret"; caret.textContent = "›";
    head.appendChild(caret);
    var titles = document.createElement("span");
    titles.className = "user-group-titles";
    var tit = document.createElement("span");
    tit.className = "user-group-title"; tit.textContent = title;
    titles.appendChild(tit);
    if (subtitle) {
      var sub = document.createElement("span");
      sub.className = "user-group-sub"; sub.textContent = subtitle;
      titles.appendChild(sub);
    }
    head.appendChild(titles);
    var pill = document.createElement("span");
    pill.className = "user-group-count"; pill.textContent = String(count);
    head.appendChild(pill);
    head.addEventListener("click", function () {
      var nowOpen = sec.classList.toggle("is-open");
      usersOpen[key] = nowOpen;
      storeSet(USERS_OPEN_KEY, usersOpen);
      head.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    });
    sec.appendChild(head);

    var body = document.createElement("div");
    body.className = "user-group-body";
    (bodyNodes || []).forEach(function (n) { body.appendChild(n); });
    sec.appendChild(body);
    return sec;
  }

  function renderUsers() {
    if (!canManageRoles()) return;
    if (!el.usersSections) return;
    closeActionsMenu(); // drop any open row dropdown before rebuilding the tables
    var users = cache.users || [];
    el.usersSections.innerHTML = "";
    // Keep the legacy hidden tbody empty (older code/selectors may still touch it).
    if (el.usersTbody) el.usersTbody.innerHTML = "";

    var pending = [], trainees = [], volunteers = [], staff = [];
    users.forEach(function (u) {
      var approved = (u.status || "Approved") === "Approved";
      if (!approved) { pending.push(u); return; }
      if (u.isVolunteer) { volunteers.push(u); return; }
      if (isTraineeRole(u.role)) { trainees.push(u); return; }
      staff.push(u);
    });

    // 1) Pending approval — rendered first to flag new registrations.
    var pendingBody = pending.length
      ? [buildUsersTable(["שם", "דוא״ל", "סטטוס", "פעולות"], pending, function (u) {
          var isSelf = state.user && u.id === state.user.id;
          var tr = document.createElement("tr");
          tr.appendChild(uCellName(u, isSelf));
          tr.appendChild(uCellEmail(u));
          tr.appendChild(uCellStatus(u));
          tr.appendChild(uCellActions(u, isSelf));
          return tr;
        })]
      : [usersEmptyNote("אין משתמשים הממתינים לאישור.")];
    el.usersSections.appendChild(
      buildUserSection("pending", "ממתינים לאישור מנהל", "חשבונות חדשים הדורשים אישור גישה",
        pending.length, false, pendingBody, "is-pending")
    );

    // 2) Active trainees, sub-grouped by training course.
    var byCourse = {}, courseOrder = [];
    trainees.forEach(function (u) {
      var key = (u.course || "").trim() || COURSE_UNASSIGNED;
      if (!byCourse[key]) { byCourse[key] = []; courseOrder.push(key); }
      byCourse[key].push(u);
    });
    courseOrder.sort(function (a, b) {
      function rank(c) {
        if (c === COURSE_UNASSIGNED) return 999;
        var i = courseList().indexOf(c);
        return i < 0 ? 500 : i;
      }
      return rank(a) - rank(b);
    });
    var traineeBody = [];
    if (!trainees.length) {
      traineeBody.push(usersEmptyNote("אין משתלמים פעילים."));
    } else {
      courseOrder.forEach(function (courseKey) {
        var list = byCourse[courseKey];
        var table = buildUsersTable(
          ["שם", "דוא״ל", "קורס", "משתלם פעיל", "נדרש טופס חניכה", "תפקיד", "שלב הסמכה", "יעדי שלבים (1-4)", "סטאז'ר", "שומר שבת", "ללא לילות", "ללא שישי+שבת", "יעד שבועי", "משמרות (השבוע)", "מונה משמרות", "פעולות"],
          list,
          function (u) {
            var isSelf = state.user && u.id === state.user.id;
            var tr = document.createElement("tr");
            if (u.activeTrainee === false) tr.className = "is-inactive";
            tr.appendChild(uCellName(u, isSelf));
            tr.appendChild(uCellEmail(u));
            tr.appendChild(uCellCourse(u));
            tr.appendChild(uCellActive(u));
            tr.appendChild(uCellFormRequired(u));
            tr.appendChild(uCellRole(u));
            tr.appendChild(uCellStage(u));
            tr.appendChild(uCellCustomStages(u));
            tr.appendChild(uCellIntern(u));
            tr.appendChild(uCellShabbat(u));
            tr.appendChild(uCellRestrictNight(u));
            tr.appendChild(uCellRestrictWeekend(u));
            tr.appendChild(uCellTarget(u));
            tr.appendChild(uCellShifts(u));
            tr.appendChild(uCellShiftCount(u));
            tr.appendChild(uCellActions(u, isSelf));
            return tr;
          }
        );
        var activeCount = list.filter(function (u) { return u.activeTrainee !== false; }).length;
        traineeBody.push(
          buildUserSection("course:" + courseKey, courseKey,
            activeCount + " פעילים מתוך " + list.length, list.length, false, [table], "user-subgroup")
        );
      });
    }
    el.usersSections.appendChild(
      buildUserSection("trainees", "משתלמים פעילים",
        "מקובצים לפי קורס הכשרה; ביטול הסימון \"משתלם פעיל\" מוציא מהשיבוץ האוטומטי",
        trainees.length, false, traineeBody, "is-trainees")
    );

    // 3) Volunteer paramedics / external staff.
    var volBody = volunteers.length
      ? [buildUsersTable(["שם", "דוא״ל", "גישה למערכת", "תפקיד", "פעולות"], volunteers, function (u) {
          var isSelf = state.user && u.id === state.user.id;
          var tr = document.createElement("tr");
          tr.appendChild(uCellName(u, isSelf));
          tr.appendChild(uCellEmail(u));
          tr.appendChild(uCellAccess(u));
          tr.appendChild(uCellRole(u));
          tr.appendChild(uCellActions(u, isSelf));
          return tr;
        })]
      : [usersEmptyNote("אין פראמדיקים / מתנדבים רשומים. ניתן לסמן משתמש כ\"מתנדב\" מתוך כפתורי הפעולה בשורה שלו.")];
    el.usersSections.appendChild(
      buildUserSection("volunteers", "פראמדיקים / מתנדבים",
        "עובדי משמרות שאינם חייבים גישה מלאה למערכת", volunteers.length, false, volBody, "is-volunteers")
    );

    // 4) Managers & staff (approved, non-trainee, non-volunteer) — preserved so
    // no account is ever hidden from administration.
    if (staff.length) {
      var staffBody = [buildUsersTable(["שם", "דוא״ל", "סטטוס", "תפקיד", "פעולות"], staff, function (u) {
        var isSelf = state.user && u.id === state.user.id;
        var tr = document.createElement("tr");
        tr.appendChild(uCellName(u, isSelf));
        tr.appendChild(uCellEmail(u));
        tr.appendChild(uCellStatus(u));
        tr.appendChild(uCellRole(u));
        tr.appendChild(uCellActions(u, isSelf));
        return tr;
      })];
      el.usersSections.appendChild(
        buildUserSection("staff", "מנהלים וצוות", "חשבונות ניהול ועריכה",
          staff.length, false, staffBody, "is-staff")
      );
    }
  }

  // Persist a trainee's training-course assignment.
  function saveUserCourse(userId, course) {
    api("PATCH", "users/" + userId, { course: course }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.course = course; });
      renderUsers();
      toast("הקורס עודכן ונשמר", true);
    }).catch(function () { toast("עדכון הקורס נכשל", false); renderUsers(); });
  }

  /* ---------------- Course catalog management (admin) ----------------
     The global list of training courses lives server-side (settings.courses).
     This panel — inside the user-management screen — lets an admin add, rename,
     and remove courses; every change persists immediately and re-renders both the
     list here and the per-trainee course dropdowns above, since they read the
     same cache.courses. */
  var ICON_PENCIL = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/></svg>';
  // Curved return-arrow for the global "ביטול פעולה אחרונה" (undo) control.
  var ICON_UNDO = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>';

  /* ---------------- Edit-mode pencil + global undo history ----------------
     The daily board and the monthly grid share one opt-in edit mode. It is
     toggled by a pencil icon in each view's header (not a switch): a plain
     button that highlights while edit mode is active. Every scheduling change
     made while editing also records a reversible snapshot on state.undoStack,
     so a single "ביטול פעולה אחרונה" button can revert the last change made in
     either tab. */

  // A round pencil button that toggles an edit mode on/off. `active` drives the
  // highlighted styling; `onToggle` receives no args and flips the caller's flag.
  function buildEditPencil(active, onToggle) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "edit-pencil-btn" + (active ? " is-active" : "");
    b.innerHTML = ICON_PENCIL;
    b.setAttribute("aria-pressed", active ? "true" : "false");
    b.setAttribute("aria-label", "מצב עריכה");
    b.title = active ? "מצב עריכה פעיל — לחצו לחזרה לצפייה בלבד" : "עריכת שיבוצים";
    b.addEventListener("click", onToggle);
    return b;
  }

  // The shared "undo last action" button. Every rendered instance carries the
  // .undo-action-btn class so updateUndoButtons() can enable/disable them all at
  // once as the shared stack grows and shrinks.
  function buildUndoButton() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "undo-action-btn";
    b.innerHTML = ICON_UNDO + '<span>ביטול פעולה אחרונה</span>';
    var n = state.undoStack.length;
    b.disabled = !n;
    b.title = n ? ("ביטול: " + state.undoStack[n - 1].desc) : "אין פעולה לביטול";
    b.addEventListener("click", undoLastAction);
    return b;
  }

  // Record a reversible action. `entry` is a plain snapshot (see autoSaveDay /
  // matrixAssign) — never live references — so the revert is deterministic.
  function pushUndo(entry) {
    state.undoStack.push(entry);
    if (state.undoStack.length > 50) state.undoStack.shift(); // bound the history
    updateUndoButtons();
  }

  // Reflect the current stack depth onto every visible undo button.
  function updateUndoButtons() {
    var n = state.undoStack.length;
    var last = n ? state.undoStack[n - 1] : null;
    var btns = document.querySelectorAll(".undo-action-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = !n;
      btns[i].title = last ? ("ביטול: " + last.desc) : "אין פעולה לביטול";
    }
  }

  // Revert the absolute last scheduling change, whichever tab produced it. The
  // snapshot holds the prior `shifts` to re-PUT through the same schedules
  // endpoint the forward edits use (a single station for the matrix, the whole
  // day for the board), then resync the local cache and repaint the affected UI.
  function undoLastAction() {
    if (!state.undoStack.length) return;
    var e = state.undoStack.pop();
    updateUndoButtons();

    api("PUT", "schedules/" + e.iso, { shifts: e.revertShifts }).then(function () {
      if (e.source === "matrix") {
        (cache.matrix[e.iso] || (cache.matrix[e.iso] = {}))[String(e.stationId)] = e.prev;
        var td = byId(matrixCellId(e.iso, e.stationId));
        if (td) fillMatrixCell(td, e.iso, e.station);
        refreshMatrixCounts(e.iso);
      } else { // daily board: the whole day's shift map was snapshotted
        if (cache.day && cache.day.iso === e.iso) {
          cache.day.shifts = e.revertShifts;
          if (state.selectedDate === e.iso) renderDayDetail(e.iso);
        }
        refreshShiftCounts();
        loadMonth();
      }
      toast("הפעולה בוטלה", true);
    }).catch(function () {
      // Restore the entry so the admin can retry the undo.
      state.undoStack.push(e);
      updateUndoButtons();
      toast("ביטול הפעולה נכשל. נסו שוב", false);
    });
  }

  // Apply a fresh course list returned by the server and refresh every surface
  // that depends on it (the editor list + the trainee table dropdowns/grouping).
  function applyCourses(list) {
    cache.courses = list || [];
    renderCoursesPanel();
    renderUsers();
  }

  // (Re)build the admin course list with inline rename/delete controls.
  function renderCoursesPanel() {
    if (!canManageRoles()) return;
    if (!el.coursesList) return;
    el.coursesList.innerHTML = "";

    var list = (cache.courses || []);
    if (!list.length) {
      var empty = document.createElement("li");
      empty.className = "courses-empty";
      empty.textContent = "אין קורסים מוגדרים. הוסיפו קורס ראשון — עד אז יוצג רק “ללא שיוך לקורס”.";
      el.coursesList.appendChild(empty);
      return;
    }

    list.forEach(function (name) {
      var li = document.createElement("li");
      li.className = "course-item";

      var label = document.createElement("span");
      label.className = "course-item-name";
      label.textContent = name;
      li.appendChild(label);

      var actions = document.createElement("span");
      actions.className = "course-item-actions";

      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn-icon course-edit";
      edit.title = "שינוי שם הקורס";
      edit.setAttribute("aria-label", "שינוי שם הקורס " + name);
      edit.innerHTML = ICON_PENCIL;
      (function (cur) {
        edit.addEventListener("click", function () { renameCourse(cur); });
      })(name);
      actions.appendChild(edit);

      var trash = document.createElement("button");
      trash.type = "button";
      trash.className = "btn-icon btn-trash course-delete";
      trash.title = "מחיקת הקורס";
      trash.setAttribute("aria-label", "מחיקת הקורס " + name);
      trash.innerHTML = ICON_TRASH;
      (function (cur) {
        trash.addEventListener("click", function () { deleteCourse(cur); });
      })(name);
      actions.appendChild(trash);

      li.appendChild(actions);
      el.coursesList.appendChild(li);
    });
  }

  // Add a new course from the inline form.
  function onAddCourse(e) {
    e.preventDefault();
    if (!canManageRoles()) return;
    var name = (el.courseName.value || "").trim();
    if (!name) { toast("יש להזין שם קורס", false); return; }

    api("POST", "settings/courses", { name: name }).then(function (res) {
      el.courseName.value = "";
      applyCourses(res && res.courses);
      toast("הקורס נוסף ונשמר", true);
    }).catch(function (err) {
      toast(err && err.status === 409 ? "הקורס כבר קיים" : "הוספת הקורס נכשלה", false);
    });
  }

  // Rename an existing course (prompts for the new name).
  function renameCourse(oldName) {
    if (!canManageRoles()) return;
    var input = window.prompt("הזן/י שם חדש לקורס:", oldName);
    if (input === null) return; // cancelled
    var newName = input.trim();
    if (!newName) { toast("שם הקורס אינו יכול להיות ריק", false); return; }
    if (newName === oldName) return; // unchanged

    api("PUT", "settings/courses", { oldName: oldName, newName: newName }).then(function (res) {
      applyCourses(res && res.courses);
      // The server also migrates assigned trainees to the new name; pull a fresh
      // user list so the table reflects that without a manual refresh.
      refreshUsers();
      toast("שם הקורס עודכן ונשמר", true);
    }).catch(function (err) {
      toast(err && err.status === 409 ? "קיים כבר קורס בשם זה" : "עדכון הקורס נכשל", false);
    });
  }

  // Delete a course after confirmation. Trainees on it fall back to "unassigned".
  function deleteCourse(name) {
    if (!canManageRoles()) return;
    if (!window.confirm("למחוק את הקורס “" + name + "”? משתלמים המשויכים אליו יעברו ל“ללא שיוך לקורס”.")) return;

    api("DELETE", "settings/courses", { name: name }).then(function (res) {
      applyCourses(res && res.courses);
      refreshUsers(); // detached trainees changed server-side
      toast("הקורס נמחק", true);
    }).catch(function () { toast("מחיקת הקורס נכשלה", false); });
  }

  // Toggle the "משתלם פעיל" flag. Inactive trainees are dropped from the
  // auto-assignment engine (enforced server-side) and the submission tracker.
  function toggleActiveTrainee(userId, active) {
    api("PATCH", "users/" + userId, { activeTrainee: active }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.activeTrainee = active; });
      renderUsers();
      toast(active ? "המשתלם סומן כפעיל" : "המשתלם סומן כ“סיים/השתחרר” והוסר מהשיבוץ האוטומטי", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Move a user in/out of the volunteers group.
  function toggleVolunteer(userId, isVol) {
    api("PATCH", "users/" + userId, { isVolunteer: isVol }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.isVolunteer = isVol; });
      renderUsers();
      toast(isVol ? "המשתמש סווג כמתנדב" : "המשתמש הוחזר לרשימה הרגילה", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Admin overrule of email verification: flip is_verified for any user from the
  // dashboard, independent of whether they clicked their verification link.
  function toggleVerified(userId, value) {
    api("PATCH", "users/" + userId, { isVerified: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.isVerified = value; });
      renderUsers();
      toast(value ? "הדוא״ל סומן כמאומת" : "סימון האימות הוסר", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Persist a trainee's "סטאז'ר" flag. No full re-render on success — the switch
  // already reflects its new state — so toggling stays snappy.
  function saveIntern(userId, value, txt) {
    api("PATCH", "users/" + userId, { isIntern: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.isIntern = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "סטאז'ר" : "לא";
      }
      toast(value ? "סומן כסטאז'ר" : "סימון הסטאז'ר הוסר", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Persist a trainee's "שומר שבת" flag. Like the "סטאז'ר" toggle, updates in place
  // without a full re-render so the switch stays responsive.
  function saveShabbat(userId, value, txt) {
    api("PATCH", "users/" + userId, { shabbatKeeper: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.shabbatKeeper = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "שומר שבת" : "לא";
      }
      toast(value ? "סומן כשומר שבת" : "סימון שומר השבת הוסר", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Persist a trainee's "לא זמין למשמרות לילה" flag. Like the "שומר שבת" toggle,
  // updates in place without a full re-render so the switch stays responsive.
  function saveRestrictNight(userId, value, txt) {
    api("PATCH", "users/" + userId, { restrictNightShifts: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.restrictNightShifts = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "ללא לילות" : "לא";
      }
      toast(value ? "סומן כלא זמין למשמרות לילה" : "ההגבלה על משמרות לילה הוסרה", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Persist a trainee's "ללא שישי+שבת" flag. Like the "ללא לילות" toggle, updates in
  // place without a full re-render so the switch stays responsive.
  function saveRestrictWeekend(userId, value, txt) {
    api("PATCH", "users/" + userId, { restrictWeekendShifts: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.restrictWeekendShifts = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "ללא שישי+שבת" : "לא";
      }
      toast(value ? "סומן כלא זמין בשישי+שבת" : "ההגבלה על שישי+שבת הוסרה", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Persist a user's "נדרש טופס חניכה" flag. Stored server-side in a persistent
  // settings-backed id list (no schema migration), and reflected immediately in
  // the users cache so the toggle feels instant.
  function saveFormRequiredPermission(userId, value, txt) {
    api("PATCH", "users/" + userId, { formRequiredPermission: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.formRequiredPermission = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "נדרש" : "לא";
      }
      toast(value ? "סומן כנדרש טופס חניכה" : "בוטל הסימון \"נדרש טופס חניכה\"", true);
    }).catch(function () { toast("העדכון נכשל", false); renderUsers(); });
  }

  // Persist a trainee's certification stage ("שלב הסמכה"). Updates the cache in
  // place; no full re-render needed since the dropdown already shows the choice.
  function saveUserStage(userId, stage) {
    api("PATCH", "users/" + userId, { traineeStage: stage }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.traineeStage = stage; });
      toast("שלב ההסמכה עודכן", true);
    }).catch(function () { toast("עדכון שלב ההסמכה נכשל", false); renderUsers(); });
  }

  // Persist a trainee's custom stage ladder (the "מסלול מותאם אישית" toggle and/or
  // its four per-stage targets). Patches the cache in place so the inputs keep their
  // freshly-typed values; a failure re-renders to restore the server truth.
  function saveUserCustomStages(userId, payload) {
    api("PATCH", "users/" + userId, payload).then(function () {
      (cache.users || []).forEach(function (u) {
        if (u.id !== userId) return;
        if (payload.customStageTargets !== undefined) u.customStageTargets = payload.customStageTargets;
        ["stage1Target", "stage2Target", "stage3Target", "stage4Target"].forEach(function (k) {
          if (payload[k] !== undefined) u[k] = payload[k];
        });
      });
      toast("יעדי השלבים המותאמים נשמרו", true);
    }).catch(function () { toast("שמירת יעדי השלבים נכשלה", false); renderUsers(); });
  }

  function changeUserRole(userId, newRole) {
    api("PATCH", "users/" + userId, { role: newRole }).then(function () {
      // Self role change re-applies permissions live by re-pulling the full
      // bootstrap (the new role may grant or revoke whole tabs).
      if (state.user && userId === state.user.id) {
        return bootstrapAndEnter().then(function () { toast("התפקיד עודכן ונשמר", true); });
      }
      return refreshUsers().then(function () { toast("התפקיד עודכן ונשמר", true); });
    }).catch(function () { toast("העדכון נכשל", false); });
  }

  function setUserStatus(userId, newStatus) {
    api("PATCH", "users/" + userId, { status: newStatus }).then(function () {
      return refreshUsers();
    }).then(function () {
      toast(newStatus === "Approved" ? "הגישה אושרה ונשמרה" : "הגישה נחסמה ונשמרה", true);
    }).catch(function () { toast("הפעולה נכשלה", false); });
  }

  function deleteUser(userId) {
    if (!canManageRoles()) return;
    if (state.user && userId === state.user.id) {
      window.alert("אינך יכול למחוק את החשבון של עצמך בזמן שאתה מחובר.");
      return;
    }
    if (!window.confirm("האם אתה בטוח שברצונך למחוק את משתמש זה לצמיתות?")) return;

    api("DELETE", "users/" + userId).then(function () {
      return refreshUsers();
    }).then(function () {
      toast("המשתמש נמחק מהמערכת", true);
    }).catch(function () { toast("המחיקה נכשלה", false); });
  }

  // Admin: rename a registered user. Prompts for a new full name (pre-filled with
  // the current one), persists it, then refreshes so the new name shows in the
  // table and — via the server-side cascade — across calendar assignments.
  function editUserName(userId, currentName) {
    if (!canManageRoles()) return;
    var input = window.prompt("הזן/י שם מלא חדש עבור המשתמש:", currentName || "");
    if (input === null) return; // cancelled
    var newName = input.trim();
    if (!newName) { toast("השם אינו יכול להיות ריק", false); return; }
    if (newName === (currentName || "")) return; // unchanged

    api("PATCH", "users/" + userId, { name: newName }).then(function () {
      // If the admin renamed themselves, update the live session + topbar greeting.
      if (state.user && userId === state.user.id) {
        state.user.name = newName;
        el.userName.textContent = newName;
      }
      return refreshUsers();
    }).then(function () {
      // Reload the open day so the renamed person appears in its shift cards, and
      // re-render the calendar grid (its per-user markers key on the name).
      if (state.selectedDate) {
        var iso = state.selectedDate;
        loadDay(iso).then(function () { if (state.selectedDate === iso) renderDayDetail(iso); });
      }
      renderCalendar();
      toast("השם עודכן ונשמר", true);
    }).catch(function () { toast("עדכון השם נכשל", false); });
  }

  /* ---------------- Role & permissions management (dynamic RBAC) ---------------- */
  // Re-pull the role definitions from the server into the cache.
  function refreshRoles() {
    return api("GET", "roles").then(function (d) {
      cache.roles = (d && d.roles) || [];
    }).catch(function () { /* keep last known roles */ });
  }

  // Which permission categories are expanded in the role matrix. Empty = all
  // collapsed (the default), so an admin sees a tidy per-category summary and
  // opens just the group they want to fine-tune.
  var matrixOpen = {};

  // Render the "add role" permission checkboxes + the full permissions matrix.
  // Manager-only; everyone else never sees the panel (the tab itself is gated).
  function renderRolesPanel() {
    if (!canManageRoles()) return;
    renderNewRoleForm();
    renderRolesMatrix();
  }

  // Ensure the roles-permissions matrix is horizontally scrollable when many
  // columns are present (e.g. full 13-tab visibility permissions).
  function ensureRolesMatrixScroller() {
    if (!el.rolesMatrixHead || !el.rolesMatrixBody) return;
    var table = el.rolesMatrixHead.closest("table");
    if (!table) return;
    var parent = table.parentElement;
    if (!parent) return;

    var wrapper = parent;
    if (!parent.classList.contains("roles-matrix-scroll")) {
      wrapper = document.createElement("div");
      wrapper.className = "roles-matrix-scroll w-full overflow-x-auto whitespace-nowrap block";
      wrapper.style.width = "100%";
      wrapper.style.overflowX = "auto";
      wrapper.style.whiteSpace = "nowrap";
      wrapper.style.display = "block";
      parent.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    }

    table.style.minWidth = "max-content";
    table.style.width = "100%";
    el.rolesMatrixHead.style.whiteSpace = "nowrap";
    el.rolesMatrixBody.style.whiteSpace = "nowrap";
  }

  // (Re)build the permission checkboxes for the "new role" form, grouped into
  // collapsible category sections. A fresh role defaults to view-only — the
  // safest baseline. Collapsing/expanding a section only toggles a CSS class on
  // the existing DOM (never a re-render), so in-progress checkbox choices are
  // preserved; the inputs stay in the DOM while hidden so `onAddRole` can read
  // them regardless of which sections are open.
  function renderNewRoleForm() {
    if (!el.roleNewPerms) return;
    el.roleNewPerms.innerHTML = "";
    el.roleNewPerms.className = "perm-accordion";

    PERM_GROUPS.forEach(function (group) {
      var groupEl = document.createElement("div");
      groupEl.className = "perm-group";

      var head = document.createElement("button");
      head.type = "button";
      head.className = "perm-group-head";
      head.setAttribute("aria-expanded", "false");
      var caret = document.createElement("span");
      caret.className = "perm-group-caret";
      caret.textContent = "›";
      head.appendChild(caret);
      var title = document.createElement("span");
      title.className = "perm-group-title";
      title.textContent = group.label;
      head.appendChild(title);
      var count = document.createElement("span");
      count.className = "perm-group-count";
      count.textContent = String(group.keys.length);
      head.appendChild(count);
      head.addEventListener("click", function () {
        var open = groupEl.classList.toggle("is-open");
        head.setAttribute("aria-expanded", open ? "true" : "false");
      });
      groupEl.appendChild(head);

      var body = document.createElement("div");
      body.className = "perm-group-body";
      group.keys.forEach(function (key) {
        var def = permDef(key);
        var lbl = document.createElement("label");
        lbl.className = "perm-check";
        var box = document.createElement("input");
        box.type = "checkbox";
        box.id = "new-perm-" + key;
        if (key === "canViewSchedule") box.checked = true;
        lbl.appendChild(box);
        lbl.appendChild(document.createTextNode(def ? def.label : key));
        body.appendChild(lbl);
      });
      groupEl.appendChild(body);
      el.roleNewPerms.appendChild(groupEl);
    });
  }

  // Render the roles × permissions matrix. Permission columns are grouped under
  // collapsible category headers (default collapsed); a collapsed category shows
  // a single "granted / total" summary cell per role instead of its checkboxes.
  function renderRolesMatrix() {
    if (!el.rolesMatrixHead || !el.rolesMatrixBody) return;
    ensureRolesMatrixScroller();
    var roles = cache.roles || [];

    // Two-tier header: a category row whose toggles expand/collapse each group,
    // and a sub-row with the individual flag labels (or a spacer when collapsed).
    el.rolesMatrixHead.innerHTML = "";
    var topRow = document.createElement("tr");
    var subRow = document.createElement("tr");

    var thRole = document.createElement("th");
    thRole.textContent = "תפקיד";
    thRole.rowSpan = 2;
    topRow.appendChild(thRole);

    PERM_GROUPS.forEach(function (group) {
      var open = !!matrixOpen[group.id];
      var thCat = document.createElement("th");
      thCat.className = "perm-cat-head" + (open ? " is-open" : "");
      thCat.colSpan = open ? group.keys.length : 1;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cat-toggle";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      var caret = document.createElement("span");
      caret.className = "cat-caret";
      caret.textContent = "›";
      btn.appendChild(caret);
      btn.appendChild(document.createTextNode(group.label));
      var count = document.createElement("span");
      count.className = "cat-count";
      count.textContent = String(group.keys.length);
      btn.appendChild(count);
      (function (gid) {
        btn.addEventListener("click", function () {
          matrixOpen[gid] = !matrixOpen[gid];
          renderRolesMatrix();
        });
      })(group.id);
      thCat.appendChild(btn);
      topRow.appendChild(thCat);

      if (open) {
        group.keys.forEach(function (key) {
          var def = permDef(key);
          var th = document.createElement("th");
          th.className = "perm-sub-head";
          th.textContent = def ? def.label : key;
          subRow.appendChild(th);
        });
      } else {
        var spacer = document.createElement("th");
        spacer.className = "perm-sub-head perm-sub-collapsed";
        spacer.setAttribute("aria-hidden", "true");
        subRow.appendChild(spacer);
      }
    });

    var thQuota = document.createElement("th");
    thQuota.textContent = "יעד שבועי";
    thQuota.rowSpan = 2;
    thQuota.title = "ברירת מחדל של משמרות בשבוע לתפקיד זה; מתמלאת אוטומטית בפרופיל בעת שיוך משתמש לתפקיד";
    topRow.appendChild(thQuota);

    var thStages = document.createElement("th");
    thStages.className = "th-stage-target";
    thStages.textContent = "יעדי שלבים (1–4)";
    thStages.rowSpan = 2;
    thStages.title = "מספר המשמרות שהושלמו הנדרש כדי לעבור כל שלב הסמכה (1 עד 4) עבור תפקיד זה; מזין את מד ההתקדמות בהסמכה של המשתלם";
    topRow.appendChild(thStages);

    var thActions = document.createElement("th");
    thActions.textContent = "פעולות";
    thActions.rowSpan = 2;
    topRow.appendChild(thActions);

    el.rolesMatrixHead.appendChild(topRow);
    el.rolesMatrixHead.appendChild(subRow);

    // One row per role: live toggles for an expanded category, a summary pill
    // for a collapsed one.
    el.rolesMatrixBody.innerHTML = "";
    roles.forEach(function (role) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.className = "perm-cell-name";
      tdName.setAttribute("data-label", "תפקיד");
      tdName.textContent = roleOptionLabel(role.name);
      if (role.isSystem) {
        var sys = document.createElement("span");
        sys.className = "role-system-tag";
        sys.textContent = "מובנה";
        tdName.appendChild(document.createTextNode(" "));
        tdName.appendChild(sys);
      }
      tr.appendChild(tdName);

      PERM_GROUPS.forEach(function (group) {
        if (matrixOpen[group.id]) {
          group.keys.forEach(function (key) {
            var def = permDef(key);
            var td = document.createElement("td");
            td.className = "perm-cell";
            td.setAttribute("data-label", def ? def.label : key);
            var box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !!(role.permissions && role.permissions[key]);
            box.setAttribute("aria-label", (def ? def.label : key) + " — " + role.name);
            (function (roleObj, k, input) {
              input.addEventListener("change", function () {
                updateRolePermission(roleObj, k, input.checked, input);
              });
            })(role, key, box);
            td.appendChild(box);
            tr.appendChild(td);
          });
        } else {
          var granted = 0;
          group.keys.forEach(function (key) {
            if (role.permissions && role.permissions[key]) granted++;
          });
          var td = document.createElement("td");
          td.className = "perm-cell perm-cell-collapsed";
          td.setAttribute("data-label", group.label);
          var pill = document.createElement("span");
          pill.className = "perm-count-pill" + (granted ? " has" : "");
          pill.textContent = granted + "/" + group.keys.length;
          pill.setAttribute("aria-label", group.label + ": " + granted + " מתוך " + group.keys.length);
          td.appendChild(pill);
          tr.appendChild(td);
        }
      });

      // Default WEEKLY quota for this role. Editing it persists immediately and
      // pre-populates the personal target of users assigned this role afterward.
      var tdQuota = document.createElement("td");
      tdQuota.className = "perm-cell-quota";
      tdQuota.setAttribute("data-label", "יעד שבועי");
      var quotaInput = document.createElement("input");
      quotaInput.type = "number";
      quotaInput.min = "0";
      quotaInput.step = "1";
      quotaInput.inputMode = "numeric";
      quotaInput.dir = "ltr";
      quotaInput.className = "target-input role-quota-input";
      quotaInput.value = String(Number(role.defaultWeeklyQuota) || 0);
      quotaInput.setAttribute("aria-label", "יעד שבועי עבור " + role.name);
      (function (roleObj, input) {
        var commit = function () {
          var v = parseInt(input.value, 10);
          if (!Number.isFinite(v) || v < 0) v = 0;
          input.value = String(v);
          updateRoleQuota(roleObj, v, input);
        };
        input.addEventListener("change", commit);
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
      })(role, quotaInput);
      tdQuota.appendChild(quotaInput);
      tr.appendChild(tdQuota);

      // Per-role certification-stage targets: four compact inputs (stage 1→4), the
      // number of completed shifts a trainee of this role needs to clear each stage.
      // Editing any one persists all four together and feeds the progress tracker.
      var tdStages = document.createElement("td");
      tdStages.className = "perm-cell-stages";
      tdStages.setAttribute("data-label", "יעדי שלבים");
      var stagesWrap = document.createElement("div");
      stagesWrap.className = "role-stage-inputs";
      var st = normalizeStageTargets(role.stageTargets);
      var stageVals = [st.stage1RequiredShifts, st.stage2RequiredShifts, st.stage3RequiredShifts, st.stage4RequiredShifts];
      var stageInputs = [];
      stageVals.forEach(function (val, idx) {
        var wrap = document.createElement("label");
        wrap.className = "role-stage-input";
        var tag = document.createElement("span");
        tag.className = "role-stage-tag";
        tag.textContent = String(idx + 1);
        wrap.appendChild(tag);
        var input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.inputMode = "numeric";
        input.dir = "ltr";
        input.className = "target-input role-stage-target";
        input.value = String(val);
        input.setAttribute("aria-label", "יעד שלב " + (idx + 1) + " עבור " + role.name);
        wrap.appendChild(input);
        stagesWrap.appendChild(wrap);
        stageInputs.push(input);
      });
      (function (roleObj, inputs) {
        var commit = function () {
          updateRoleStageTargets(roleObj, inputs);
        };
        inputs.forEach(function (input) {
          input.addEventListener("change", commit);
          input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
        });
      })(role, stageInputs);
      tdStages.appendChild(stagesWrap);
      tr.appendChild(tdStages);

      var tdActions = document.createElement("td");
      tdActions.setAttribute("data-label", "פעולות");
      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn-xs btn-block-user";
      del.textContent = "מחק תפקיד";
      // Built-in roles can't be deleted; the server enforces this too.
      del.disabled = !!role.isSystem;
      (function (roleObj) {
        del.addEventListener("click", function () { deleteRole(roleObj); });
      })(role);
      tdActions.appendChild(del);
      tr.appendChild(tdActions);

      el.rolesMatrixBody.appendChild(tr);
    });
  }

  // Create a new custom role from the form's name + checked permissions + the
  // optional default weekly quota.
  function onAddRole(e) {
    e.preventDefault();
    if (!canManageRoles()) return;
    var name = (el.roleName.value || "").trim();
    if (!name) { toast("יש להזין שם תפקיד", false); return; }
    var permissions = {};
    PERM_DEFS.forEach(function (def) {
      var box = byId("new-perm-" + def.key);
      permissions[def.key] = !!(box && box.checked);
    });
    var quotaInput = byId("role-weekly-quota");
    var quota = quotaInput ? parseInt(quotaInput.value, 10) : 0;
    if (!Number.isFinite(quota) || quota < 0) quota = 0;
    api("POST", "roles", { name: name, permissions: permissions, defaultWeeklyQuota: quota }).then(function () {
      el.roleName.value = "";
      if (quotaInput) quotaInput.value = "0";
      return refreshRoles();
    }).then(function () {
      renderRolesPanel();
      renderUsers(); // the new role now appears in every role dropdown
      toast("התפקיד נוסף ונשמר", true);
    }).catch(function (err) {
      toast(err && err.status === 409 ? "כבר קיים תפקיד בשם זה" : "הוספת התפקיד נכשלה", false);
    });
  }

  // Persist a single permission toggle for a role. On failure, revert the
  // checkbox. If the edited role is the current user's own role, re-bootstrap so
  // their live permissions (and visible tabs) update immediately.
  function updateRolePermission(roleObj, key, checked, input) {
    var body = { permissions: {} };
    body.permissions[key] = checked;
    api("PATCH", "roles/" + roleObj.id, body).then(function () {
      if (!roleObj.permissions) roleObj.permissions = {};
      roleObj.permissions[key] = checked;
      toast("ההרשאה עודכנה ונשמרה", true);
      if (state.user && roleObj.name === state.user.role) {
        return bootstrapAndEnter().then(function () { switchTab("users"); });
      }
    }).catch(function (err) {
      if (input) input.checked = !checked; // revert the visual state
      toast(err && err.status === 400 ? "לא ניתן לבטל את הרשאת הניהול של תפקידך" : "עדכון ההרשאה נכשל", false);
    });
  }

  // Persist a role's default weekly quota. Optimistically mirrors it into the
  // cached role so the input keeps its value across the next render.
  function updateRoleQuota(roleObj, value, input) {
    var quota = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    api("PATCH", "roles/" + roleObj.id, { defaultWeeklyQuota: quota }).then(function () {
      roleObj.defaultWeeklyQuota = quota;
      toast("יעד השבוע לתפקיד נשמר", true);
    }).catch(function () {
      if (input) input.value = String(Number(roleObj.defaultWeeklyQuota) || 0); // revert
      toast("עדכון היעד נכשל", false);
    });
  }

  // Persist a role's four certification-stage targets. Reads all four inputs so a
  // single edit saves a consistent set, mirrors them onto the cached role, and — if
  // the edited role is the current user's own — refreshes the trainee progress bar.
  function updateRoleStageTargets(roleObj, inputs) {
    var keys = ["stage1RequiredShifts", "stage2RequiredShifts", "stage3RequiredShifts", "stage4RequiredShifts"];
    var raw = {};
    keys.forEach(function (k, i) {
      var v = parseInt(inputs[i].value, 10);
      if (!Number.isFinite(v) || v < 0) v = 0;
      inputs[i].value = String(v); // clamp the visible value
      raw[k] = v;
    });
    var targets = normalizeStageTargets(raw);
    var prev = normalizeStageTargets(roleObj.stageTargets);
    api("PATCH", "roles/" + roleObj.id, { stageTargets: targets }).then(function () {
      roleObj.stageTargets = targets;
      if (state.user && roleObj.name === state.user.role) {
        cache.myStageTargets = targets;
        renderTraineeProgress();
      }
      toast("יעדי השלבים לתפקיד נשמרו", true);
    }).catch(function () {
      // Revert the inputs to the last known-good values.
      inputs[0].value = String(prev.stage1RequiredShifts);
      inputs[1].value = String(prev.stage2RequiredShifts);
      inputs[2].value = String(prev.stage3RequiredShifts);
      inputs[3].value = String(prev.stage4RequiredShifts);
      toast("עדכון יעדי השלבים נכשל", false);
    });
  }

  // Delete a custom role. The server refuses if the role is still assigned to
  // any user (409) or is a built-in role.
  function deleteRole(roleObj) {
    if (!canManageRoles() || roleObj.isSystem) return;
    if (!window.confirm("למחוק את התפקיד “" + roleObj.name + "”? פעולה זו אינה הפיכה.")) return;
    api("DELETE", "roles/" + roleObj.id).then(function () {
      return refreshRoles();
    }).then(function () {
      renderRolesPanel();
      renderUsers();
      toast("התפקיד נמחק", true);
    }).catch(function (err) {
      toast(err && err.status === 409 ? "לא ניתן למחוק תפקיד שמשויך למשתמשים" : "מחיקת התפקיד נכשלה", false);
    });
  }

  /* ---------------- Availability lock configuration ---------------- */
  function renderLockConfig() {
    if (!isAdmin()) return;
    var cfg = getLockConfig();
    if (el.lockEnabled) el.lockEnabled.checked = cfg.enabled;
    if (el.lockDay) el.lockDay.value = String(cfg.day);
    if (el.lockTime) el.lockTime.value = cfg.time;
  }

  function onSaveLockConfig(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var cfg = {
      enabled: !!(el.lockEnabled && el.lockEnabled.checked),
      day: el.lockDay ? (+el.lockDay.value || 0) : DEFAULT_LOCK.day,
      time: (el.lockTime && el.lockTime.value) ? el.lockTime.value : DEFAULT_LOCK.time
    };
    api("PUT", "lock-config", cfg).then(function () {
      cache.lockConfig = cfg;
      syncDayView();
      toast("הגדרות הנעילה נשמרו", true);
    }).catch(function () { toast("ההגדרות לא נשמרו", false); });
  }

  /* ---------------- Generic-crew name masking (time-released) ----------------
     The driver ("נהג/ת") and paramedic ("פראמדיק/ית") names are withheld from
     trainee / view-only accounts until the current time is within
     cache.crewRevealHours of the shift's start, at which point they appear
     automatically. 0 disables masking. Admins — and the offline demo mode —
     always see the real names so they can build the schedule. */

  // Clamp any incoming value to a non-negative whole number of hours.
  function normalizeRevealHours(v) {
    var n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function crewRevealHours() { return normalizeRevealHours(cache.crewRevealHours); }

  // Clamp one stage target to a non-negative integer, falling back to a default.
  function normalizeStageTarget(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }
  // Coerce a raw {stageNRequiredShifts} payload into a clean object of four
  // non-negative integers, filling any missing/invalid entry from the defaults.
  function normalizeStageTargets(t) {
    t = t || {};
    return {
      stage1RequiredShifts: normalizeStageTarget(t.stage1RequiredShifts, 10),
      stage2RequiredShifts: normalizeStageTarget(t.stage2RequiredShifts, 15),
      stage3RequiredShifts: normalizeStageTarget(t.stage3RequiredShifts, 20),
      stage4RequiredShifts: normalizeStageTarget(t.stage4RequiredShifts, 25)
    };
  }
  // The stage targets for the LOGGED-IN user's specific role — what their
  // certification progress bar divides completed shifts against. Prefers the role
  // definition from the roles cache (populated for admins and during "view as"
  // impersonation) so a live edit in the matrix reflects immediately; otherwise
  // uses the role-specific set the server handed this client at bootstrap
  // (cache.myStageTargets), falling back to the global targets.
  function myStageTargetList() {
    var roleName = state.user && state.user.role;
    var role = (cache.roles || []).filter(function (r) { return r.name === roleName; })[0];
    var src = role && role.stageTargets ? role.stageTargets : (cache.myStageTargets || cache.stageTargets);
    var t = normalizeStageTargets(src);
    return [t.stage1RequiredShifts, t.stage2RequiredShifts, t.stage3RequiredShifts, t.stage4RequiredShifts];
  }

  // The standard stage-target ladder for a given role NAME, as a four-element array
  // [stage1..stage4]. Used by the user-management view to pre-fill the custom-ladder
  // inputs with the role defaults a trainee would otherwise inherit. Prefers the full
  // role definition from the roles cache (admins always have it) and falls back to the
  // global targets when the role row is absent.
  function roleStageTargetList(roleName) {
    var role = (cache.roles || []).filter(function (r) { return r.name === roleName; })[0];
    var src = role && role.stageTargets ? role.stageTargets : (cache.stageTargets || cache.myStageTargets);
    var t = normalizeStageTargets(src);
    return [t.stage1RequiredShifts, t.stage2RequiredShifts, t.stage3RequiredShifts, t.stage4RequiredShifts];
  }

  // The exact placeholder shown in place of a masked crew name, with the saved
  // window injected (e.g. "הצוות יחשף כ-12 שעות לפני המשמרת").
  function crewMaskText() {
    return "הצוות יחשף כ-" + crewRevealHours() + " שעות לפני המשמרת";
  }

  // Whether a slot's role is a "generic crew" role subject to masking. Only the
  // driver and paramedic are masked; trainee ("מלווה") slots are never hidden.
  function isCrewRole(role) { return role === "driver" || role === "medic"; }

  // Default start time per shift type, used when a shift has no explicit hours
  // string to parse (e.g. a custom shift added without hours).
  var SHIFT_DEFAULT_START = { morning: "06:00", evening: "14:00", night: "22:00" };

  // Default [start, end] window per shift band, used to prefill the add-task
  // time fields. Each stays editable, so any custom window can be entered.
  var SHIFT_DEFAULT_RANGE = {
    morning: ["06:00", "14:00"],
    evening: ["14:00", "22:00"],
    night:   ["22:00", "06:00"]
  };

  // The local Date at which a shift on `iso` begins. Reads the first HH:MM out of
  // the hours string ("06:00 – 14:00" → 06:00); falls back to the shift type's
  // default start. Returns null if nothing usable is found.
  function shiftStartDate(iso, hours, shift) {
    var parts = (iso || "").split("-");
    if (parts.length !== 3) return null;
    var hm = null;
    var m = (hours || "").match(/(\d{1,2}):(\d{2})/);
    if (m) hm = [+m[1], +m[2]];
    else if (SHIFT_DEFAULT_START[shift]) {
      var d = SHIFT_DEFAULT_START[shift].split(":");
      hm = [+d[0], +d[1]];
    }
    if (!hm || hm[0] > 23 || hm[1] > 59) return null;
    // A night shift labelled for a given day operationally BEGINS the previous
    // evening — a "Monday night" shift starts on Sunday at ~23:00 and runs into
    // Monday morning (the same night-boundary the server uses in shiftStartMs /
    // NIGHT_ANCHOR_HOUR). Its real start timestamp is therefore the day BEFORE
    // the calendar day it is filed under, so the "reveal X hours before start"
    // window must be measured from that earlier moment, not from the labelled
    // day. Without this, a night shift's crew unmasks a full day late.
    // (new Date normalises a 0/negative day back across month and year edges.)
    var dayOffset = shift === "night" ? -1 : 0;
    return new Date(+parts[0], +parts[1] - 1, +parts[2] + dayOffset, hm[0], hm[1], 0, 0);
  }

  /* ---------------- "הוסף ליומן גוגל" export ---------------- */
  // Exported events carry no location — the station is already reflected in the
  // event title, so no address is attached to the calendar entry.

  // Resolve a station's hours string ("06:00 – 14:00") from the cached station
  // list by name (+ shift when several stations share a name). Used by callers —
  // e.g. the "המשמרות שלי" table — whose rows carry a station name but no hours.
  function stationHoursFor(name, shift) {
    var list = cache.stations || [];
    var i;
    for (i = 0; i < list.length; i++) { if (list[i].name === name && list[i].shift === shift) return list[i].hours; }
    for (i = 0; i < list.length; i++) { if (list[i].name === name) return list[i].hours; }
    return "";
  }

  function slotLabelFor(key) {
    for (var i = 0; i < SLOTS.length; i++) { if (SLOTS[i].key === key) return SLOTS[i].label; }
    return "";
  }

  // Real start/end Date pair for a shift. Start reuses shiftStartDate (which
  // already rolls a night shift back to the evening it actually begins); end is
  // the second HH:MM in the hours string, bumped a day when it crosses midnight
  // (e.g. a night "22:00 – 06:00"). Falls back to an 8-hour block when only one
  // time is parseable. Returns null if no usable start can be derived.
  function shiftTimeRange(iso, hours, shift) {
    var start = shiftStartDate(iso, hours, shift);
    if (!start) return null;
    var times = (hours || "").match(/(\d{1,2}):(\d{2})/g);
    var end;
    if (times && times.length >= 2) {
      var e = times[1].split(":");
      end = new Date(start.getTime());
      end.setHours(+e[0], +e[1], 0, 0);
      if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1); // crosses midnight
    } else {
      end = new Date(start.getTime() + 8 * 3600000);
    }
    return { start: start, end: end };
  }

  // Google Calendar wants a floating local stamp: YYYYMMDDTHHMMSS (no trailing Z).
  // Paired with the ctz=Asia/Jerusalem parameter below, its render form interprets
  // these digits as Israel local time for every viewer.
  function gcalStamp(dt) {
    return "" + dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate()) +
      "T" + pad(dt.getHours()) + pad(dt.getMinutes()) + "00";
  }

  // Build a "prefill a new event" Google Calendar URL for one assigned shift.
  // Title: "משמרת מד"א - <סוג משמרת> <תחנה>". Returns null when the time range
  // can't be derived (so the caller can skip rendering the control).
  function googleCalUrl(o) {
    var range = shiftTimeRange(o.iso, o.hours, o.shift);
    if (!range) return null;
    var title = "משמרת מד\"א - " + shiftLabel(o.shift) + (o.station ? " " + o.station : "");
    var params = [
      "action=TEMPLATE",
      "text=" + encodeURIComponent(title),
      "dates=" + gcalStamp(range.start) + "/" + gcalStamp(range.end),
      // Pin the floating stamp to Israel time so the event lands on the exact
      // hours entered regardless of the viewer's own calendar timezone.
      "ctz=Asia/Jerusalem"
    ];
    var details = [];
    if (o.slotLabel) details.push("תפקיד: " + o.slotLabel);
    if (o.person) details.push("שם: " + o.person);
    if (details.length) params.push("details=" + encodeURIComponent(details.join("\n")));
    return "https://calendar.google.com/calendar/render?" + params.join("&");
  }

  // A ready-to-use "הוסף ליומן גוגל" control (an <a> opening the prefilled event
  // in a new tab). `compact` renders the icon-only variant used inside the board
  // grid cells; the full variant (icon + label) is used in the "המשמרות שלי"
  // table. Returns null when the shift has no derivable time (nothing to export).
  function buildGcalLink(o, compact) {
    var url = googleCalUrl(o);
    if (!url) return null;
    var a = document.createElement("a");
    a.className = "gcal-link" + (compact ? " gcal-link-compact" : "");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "הוסף ליומן גוגל";
    a.setAttribute("aria-label", "הוסף ליומן גוגל");
    var icon = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path fill="currentColor" d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm12 7v10H5V9zm-6 2h-2v2H9v2h2v2h2v-2h2v-2h-2z"/></svg>';
    a.innerHTML = icon + (compact ? "" : '<span>הוסף ליומן גוגל</span>');
    return a;
  }

  // The moment a shift's crew becomes visible (start − window), or null when
  // masking does not apply at all (admin / demo / disabled / unparseable time).
  function crewRevealAt(iso, shift, hours) {
    if (isAdmin() || state.demoMode) return null;
    var X = crewRevealHours();
    if (X <= 0) return null;
    var start = shiftStartDate(iso, hours, shift);
    if (!start) return null;
    return start.getTime() - X * 3600000;
  }

  // Is this shift's generic crew currently masked for the logged-in viewer?
  function isCrewMasked(iso, shift, hours) {
    var revealAt = crewRevealAt(iso, shift, hours);
    return revealAt != null && Date.now() < revealAt;
  }

  // Populate the admin crew-reveal input from the cached setting.
  function renderCrewRevealConfig() {
    if (!isAdmin()) return;
    if (el.crewRevealHours) el.crewRevealHours.value = String(crewRevealHours());
  }

  // Persist the crew-reveal window. Shares the /settings singleton with the
  // min-shifts value; sending only crewRevealHours leaves the rest untouched.
  function onSaveCrewReveal(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var hours = el.crewRevealHours ? normalizeRevealHours(el.crewRevealHours.value) : 0;
    api("PUT", "settings", { crewRevealHours: hours }).then(function () {
      cache.crewRevealHours = hours;
      if (el.crewRevealHours) el.crewRevealHours.value = String(hours);
      syncDayView(); // re-render the open day so masking reflects the new window
      toast("הגדרת חשיפת הצוות נשמרה", true);
    }).catch(function () { toast("ההגדרה לא נשמרה", false); });
  }

  // Clamp the deadline-reminder window to a whole number ≥ 1 (24 by default). A
  // sub-1 value falls back to 24 — the reminder is disabled by turning off the lock.
  function normalizeDeadlineHours(v) {
    var n = Math.floor(Number(v));
    return (isFinite(n) && n >= 1) ? n : 24;
  }
  function deadlineReminderHours() { return normalizeDeadlineHours(cache.deadlineReminderHours); }

  // Populate the admin deadline-reminder input from the cached setting.
  function renderDeadlineReminderConfig() {
    if (!isAdmin()) return;
    if (el.deadlineReminderHours) el.deadlineReminderHours.value = String(deadlineReminderHours());
  }

  // Persist the deadline-reminder window (hours before the weekly lock). Shares the
  // /settings singleton; sending only deadlineReminderHours leaves the rest untouched.
  function onSaveDeadlineReminder(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var hours = el.deadlineReminderHours ? normalizeDeadlineHours(el.deadlineReminderHours.value) : 24;
    api("PUT", "settings", { deadlineReminderHours: hours }).then(function () {
      cache.deadlineReminderHours = hours;
      if (el.deadlineReminderHours) el.deadlineReminderHours.value = String(hours);
      toast("הגדרת תזכורת ההגשה נשמרה", true);
    }).catch(function () { toast("ההגדרה לא נשמרה", false); });
  }

  // Mirrors the server rule for the UI: trainees see a day only when the Sunday
  // of its week is one of the published weeks; admins always see everything. The
  // server enforces this too. The published list is additive — any number of
  // (non-contiguous) weeks can be open at once, and an empty list locks all days.
  function publishedWeekSet() {
    return cache.publishedWeeks || [];
  }

  // A day is locked for a trainee when the Sunday of its week is not published.
  // Admins are never locked.
  function isDayLockedForViewer(iso) {
    if (isAdmin()) return false;
    return publishedWeekSet().indexOf(isoOf(weekStartOf(iso))) === -1;
  }

  /* ---------------- Schedule exposure (night-shift anchored) ----------------
     Independently of the manual publish list, the COMING week's schedule stays
     hidden from standard trainees until shortly before it operationally begins.
     The operational week's first shift is the Monday-night shift, which — per the
     night-shift boundary — begins on its Sunday at 23:00. Exposure opens
     EXPOSURE_HOURS_PRIOR hours before that mark (e.g. 3 → 20:00 on Sunday).
     Admins and the offline demo view are never restricted. */
  var EXPOSURE_HOURS_PRIOR = 3; // admin-configurable: hours before Sun 23:00 that the coming week is revealed

  // The exact Date a given week (by its Sunday) becomes visible: that Sunday at
  // 23:00 (the week's first night-shift start) minus EXPOSURE_HOURS_PRIOR hours.
  function exposureReleaseFor(weekSunday) {
    return new Date(
      weekSunday.getFullYear(), weekSunday.getMonth(), weekSunday.getDate(),
      23 - EXPOSURE_HOURS_PRIOR, 0, 0, 0
    );
  }

  // True when `iso` belongs to the coming week AND that week's exposure release
  // time hasn't arrived yet — so a trainee must wait. Past/current weeks and any
  // further-out week are governed by the publish list, not this time gate.
  // An EXPLICIT publish always wins: once an admin publishes the week (it appears
  // in the published list), the schedule is shown immediately and the automatic
  // time gate no longer withholds it — otherwise a freshly-published coming week
  // would stay hidden behind "יפורסם בקרוב" even though it was already published.
  function isExposurePending(iso) {
    if (isAdmin() || state.demoMode) return false;
    var wk = weekStartOf(iso);
    if (isoOf(wk) !== isoOf(upcomingWeekStart())) return false; // only the coming week is time-gated
    if (publishedWeekSet().indexOf(isoOf(wk)) !== -1) return false; // explicit publish overrides the time gate
    return new Date().getTime() < exposureReleaseFor(wk).getTime();
  }

  // "DD/MM בשעה HH:MM" — when the coming week's schedule will be exposed.
  function exposureReleaseLabel(iso) {
    var t = exposureReleaseFor(weekStartOf(iso));
    return pad(t.getDate()) + "/" + pad(t.getMonth() + 1) + " בשעה " + pad(t.getHours()) + ":" + pad(t.getMinutes());
  }

  // A single "שבוע DD/MM – DD/MM" <option> for the publish-week picker.
  function buildWeekOption(sunday, iso) {
    var end = new Date(sunday.getTime());
    end.setDate(end.getDate() + 6);
    var o = document.createElement("option");
    o.value = iso;
    o.textContent = "שבוע " + sunday.getDate() + "/" + (sunday.getMonth() + 1) +
      " – " + end.getDate() + "/" + (end.getMonth() + 1);
    return o;
  }

  // Hebrew "DD/MM – DD/MM" label for a week given its Sunday ISO.
  function weekRangeLabel(iso) {
    var sunday = weekStartOf(iso);
    var end = new Date(sunday.getTime());
    end.setDate(end.getDate() + 6);
    return sunday.getDate() + "/" + (sunday.getMonth() + 1) +
      " – " + end.getDate() + "/" + (end.getMonth() + 1);
  }

  function renderPublishConfig() {
    if (!isAdmin()) return;
    if (el.publishWeek) {
      // Pick a week to publish: this week's Sunday and several weeks ahead, each
      // labelled by its date range. Already-published weeks are filtered out so
      // the picker only offers weeks not yet open.
      el.publishWeek.innerHTML = "";
      var published = publishedWeekSet();
      var start = weekStartOf(isoOf(new Date())); // this week's Sunday (local)
      for (var i = 0; i < 12; i++) {
        var ws = new Date(start.getTime());
        ws.setDate(ws.getDate() + i * 7);
        var iso = isoOf(ws);
        if (published.indexOf(iso) !== -1) continue;
        el.publishWeek.appendChild(buildWeekOption(ws, iso));
      }
    }
    renderPublishedWeeks();
    renderPublishTrainees();
  }

  // Populate the "specific trainee" dropdown from the approved-trainee roster and
  // show/hide it depending on the chosen email target.
  function renderPublishTrainees() {
    if (!el.publishTrainee) return;
    el.publishTrainee.innerHTML = "";
    approvedTrainees()
      .filter(function (u) { return (u.email || "").trim(); })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "he"); })
      .forEach(function (u) {
        var o = document.createElement("option");
        o.value = u.email;
        o.textContent = u.name + " (" + u.email + ")";
        el.publishTrainee.appendChild(o);
      });
    syncPublishTraineeField();
  }

  // The trainee picker is only relevant when the admin chose "specific".
  function syncPublishTraineeField() {
    if (!el.publishTraineeField || !el.publishEmailTarget) return;
    el.publishTraineeField.hidden = el.publishEmailTarget.value !== "specific";
  }

  // The list of currently-published weeks, each with an "un-publish" button.
  function renderPublishedWeeks() {
    if (!el.publishedList) return;
    el.publishedList.innerHTML = "";
    var weeks = publishedWeekSet().slice().sort();
    if (!weeks.length) {
      var empty = document.createElement("li");
      empty.className = "published-empty";
      empty.textContent = "טרם פורסמו שבועות. החניכים רואים את כל הימים נעולים.";
      el.publishedList.appendChild(empty);
      return;
    }
    weeks.forEach(function (iso) {
      var li = document.createElement("li");
      li.className = "published-week-item";

      var label = document.createElement("span");
      label.className = "published-week-label";
      label.textContent = "שבוע " + weekRangeLabel(iso);
      li.appendChild(label);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost btn-sm";
      btn.setAttribute("data-unpublish", iso);
      btn.textContent = "ביטול פרסום";
      li.appendChild(btn);

      el.publishedList.appendChild(li);
    });
  }

  // Publish the selected week: add it to the additive list, then refresh.
  function onPublishWeek(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var val = el.publishWeek ? el.publishWeek.value : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) { toast("בחרו שבוע לפרסום", false); return; }

    // Email distribution choice: send to all trainees, a single trainee, or none.
    var emailTarget = el.publishEmailTarget ? el.publishEmailTarget.value : "none";
    var payload = { weekStart: val, emailTarget: emailTarget };
    if (emailTarget === "specific") {
      var trainee = el.publishTrainee ? el.publishTrainee.value : "";
      if (!trainee) { toast("בחרו חניך/ה לשליחת המייל", false); return; }
      payload.targetTraineeEmail = trainee;
    }

    api("POST", "published-weeks", payload).then(function (res) {
      cache.publishedWeeks = (res && res.weeks) || cache.publishedWeeks;
      renderPublishConfig();
      renderCalendar(); // reflect the newly opened week immediately
      var sent = res && res.email && res.email.sent;
      if (emailTarget === "none") toast("השבוע פורסם (ללא שליחת מיילים)", true);
      else toast("השבוע פורסם · נשלחו " + (sent || 0) + " מיילים", true);
    }).catch(function () { toast("השבוע לא פורסם", false); });
  }

  // Un-publish a week: drop it from the list, then refresh.
  function onUnpublishWeek(iso) {
    if (!isAdmin()) return;
    api("DELETE", "published-weeks/" + iso).then(function (res) {
      cache.publishedWeeks = (res && res.weeks) || cache.publishedWeeks;
      renderPublishConfig();
      renderCalendar();
      toast("פרסום השבוע בוטל", true);
    }).catch(function () { toast("הפעולה נכשלה", false); });
  }

  /* ---------------- Station management ---------------- */
  function renderStations() {
    if (!isAdmin()) return;
    var stations = cache.stations || [];
    el.stationsTbody.innerHTML = "";

    if (stations.length === 0) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 4;
      emptyCell.className = "empty-row";
      emptyCell.textContent = "לא הוגדרו תחנות. הוסיפו תחנה חדשה כדי שתופיע בלוח השיבוצים.";
      emptyRow.appendChild(emptyCell);
      el.stationsTbody.appendChild(emptyRow);
      return;
    }

    stations.forEach(function (st) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = st.name;

      var tdShift = document.createElement("td");
      var pill = document.createElement("span");
      pill.className = "shift-pill";
      var dot = document.createElement("span");
      dot.className = "dot " + st.shift;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(shiftLabel(st.shift)));
      tdShift.appendChild(pill);

      var tdHours = document.createElement("td");
      tdHours.className = "u-email";
      tdHours.textContent = st.hours;

      var tdActions = document.createElement("td");
      var trash = document.createElement("button");
      trash.type = "button";
      trash.className = "btn-trash";
      trash.title = "מחיקת תחנה";
      trash.setAttribute("aria-label", "מחיקת התחנה " + st.name);
      trash.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/></svg>';
      (function (id) {
        trash.addEventListener("click", function () { deleteStation(id); });
      })(st.id);
      tdActions.appendChild(trash);

      tr.appendChild(tdName);
      tr.appendChild(tdShift);
      tr.appendChild(tdHours);
      tr.appendChild(tdActions);
      el.stationsTbody.appendChild(tr);
    });
  }

  function onAddStation(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var name  = (el.stationName.value || "").trim();
    var shift = el.stationShift.value || "morning";
    var hours = (el.stationHours.value || "").trim();

    if (!name || !hours) { toast("יש להזין שם תחנה ושעות פעילות", false); return; }

    api("POST", contextQuery("stations"), { name: name, shift: shift, hours: hours, isWhiteAmbulance: state.isWhiteAmbulanceContext }).then(function () {
      return refreshStations();
    }).then(function () {
      el.stationForm.reset();
      renderStations();
      syncDayView();
      toast("התחנה נוספה ונשמרה", true);
    }).catch(function () { toast("התחנה לא נשמרה", false); });
  }

  function deleteStation(id) {
    if (!isAdmin()) return;
    api("DELETE", contextQuery("stations/" + id)).then(function () {
      return refreshStations();
    }).then(function () {
      renderStations();
      syncDayView();
      toast("התחנה נמחקה ונשמרה", true);
    }).catch(function () { toast("המחיקה נכשלה", false); });
  }

  function refreshStations() {
    return api("GET", contextQuery("stations")).then(function (list) { cache.stations = list || []; });
  }

  function syncDayView() {
    if (state.selectedDate) renderDayDetail(state.selectedDate);
  }

  /* ---------------- Roster (quick-select names) management ---------------- */
  function renderRoster() {
    if (!isAdmin()) return;
    var names = cache.roster || [];
    el.rosterTbody.innerHTML = "";

    if (names.length === 0) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 3;
      emptyCell.className = "empty-row";
      emptyCell.textContent = "הרשימה ריקה. הוסיפו שמות כדי שיופיעו בבחירה המהירה בלוח השיבוצים.";
      emptyRow.appendChild(emptyCell);
      el.rosterTbody.appendChild(emptyRow);
      return;
    }

    names.forEach(function (entry) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = entry.name;

      // "טיוטור מאושר" toggle — ON keeps an approved entry for this name in the
      // manual-tutors list below; OFF removes it. State derives from that list.
      var tdTutor = document.createElement("td");
      tdTutor.setAttribute("data-label", "טיוטור מאושר");
      var match = findApprovedManualTutor(entry.name);
      var lbl = document.createElement("label");
      lbl.className = "switch";
      var box = document.createElement("input");
      box.type = "checkbox"; box.checked = !!match;
      box.setAttribute("aria-label", "טיוטור מאושר — " + entry.name);
      var track = document.createElement("span"); track.className = "switch-track";
      var txt = document.createElement("span");
      txt.className = "switch-text" + (match ? " is-on" : " is-off");
      txt.textContent = match ? "מאושר" : "לא";
      (function (name) {
        box.addEventListener("change", function () { setRosterTutor(name, box.checked, box); });
      })(entry.name);
      lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
      tdTutor.appendChild(lbl);

      var tdActions = document.createElement("td");
      var trash = document.createElement("button");
      trash.type = "button";
      trash.className = "btn-trash";
      trash.title = "הסרת שם מהרשימה";
      trash.setAttribute("aria-label", "הסרת " + entry.name + " מהרשימה");
      trash.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/></svg>';
      (function (id) {
        trash.addEventListener("click", function () { deleteRosterName(id); });
      })(entry.id);
      tdActions.appendChild(trash);

      tr.appendChild(tdName);
      tr.appendChild(tdTutor);
      tr.appendChild(tdActions);
      el.rosterTbody.appendChild(tr);
    });
  }

  function onAddRosterName(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var name = (el.rosterName.value || "").trim();
    if (!name) { toast("יש להזין שם", false); return; }

    api("POST", "roster", { name: name }).then(function () {
      return refreshRoster();
    }).then(function () {
      el.rosterForm.reset();
      renderRoster();
      syncDayView();
      toast("השם נוסף לרשימה", true);
    }).catch(function (err) {
      if (err && err.status === 409) toast("השם כבר קיים ברשימה", false);
      else toast("השם לא נשמר", false);
    });
  }

  function deleteRosterName(id) {
    if (!isAdmin()) return;
    api("DELETE", "roster/" + id).then(function () {
      return refreshRoster();
    }).then(function () {
      renderRoster();
      syncDayView();
      toast("השם הוסר מהרשימה", true);
    }).catch(function () { toast("ההסרה נכשלה", false); });
  }

  function refreshRoster() {
    return api("GET", "roster").then(function (list) { cache.roster = list || []; });
  }

  // Case-insensitive name match used to link a roster row to its manual-tutor entry.
  function sameTutorName(a, b) {
    return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
  }

  // Returns the approved manual-tutor entry for a roster name, or null.
  function findApprovedManualTutor(name) {
    var list = cache.manualTutors || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].approved && sameTutorName(list[i].name, name)) return list[i];
    }
    return null;
  }

  // Roster-row "טיוטור מאושר" toggle. ON ensures an approved manual-tutor entry
  // exists for this name (creating one if needed); OFF removes every matching
  // entry. Saves instantly and re-renders both tables so they stay in sync.
  function setRosterTutor(name, value, box) {
    if (!isAdmin()) return;
    cache.manualTutors = cache.manualTutors || [];

    var done = function (ok, onMsg, offMsg) {
      renderManualTutors();
      renderRoster();
      if (ok) toast(value ? onMsg : offMsg, true);
      else toast("העדכון נכשל", false);
    };

    if (value) {
      var existing = null;
      cache.manualTutors.forEach(function (t) { if (sameTutorName(t.name, name)) existing = t; });
      if (existing && existing.approved) { done(true, "סומן כטיוטור מאושר"); return; }
      if (existing) {
        api("PATCH", "manual-tutors/" + existing.id, { approved: true }).then(function () {
          existing.approved = true;
          done(true, "סומן כטיוטור מאושר");
        }).catch(function () { if (box) box.checked = false; done(false); });
      } else {
        api("POST", "manual-tutors", { name: name, approved: true }).then(function (row) {
          cache.manualTutors.push(row);
          done(true, "סומן כטיוטור מאושר");
        }).catch(function () { if (box) box.checked = false; done(false); });
      }
    } else {
      var matches = cache.manualTutors.filter(function (t) { return sameTutorName(t.name, name); });
      if (!matches.length) { done(true, "", "אישור הטיוטור הוסר"); return; }
      Promise.all(matches.map(function (t) { return api("DELETE", "manual-tutors/" + t.id); })).then(function () {
        cache.manualTutors = cache.manualTutors.filter(function (t) { return !sameTutorName(t.name, name); });
        done(true, "", "אישור הטיוטור הוסר");
      }).catch(function () { if (box) box.checked = true; done(false); });
    }
  }

  /* ---------------- Approved tutors ("טיוטור מאושר") ----------------
     Lives only in the "ניהול סגל ורשימות" tab. Lists every qualified station
     paramedic (volunteers + non-trainee staff) with a "טיוטור מאושר" toggle.
     The flag is pure scheduling eligibility — the auto-assign engine pairs
     interns ("סטאז'ר") only onto shifts that already carry an approved tutor —
     and it never alters login credentials or pending/approved registration. */
  function renderApprovedTutors() {
    if (!isAdmin()) return;
    if (!el.approvedTutorsTbody) return;
    var tbody = el.approvedTutorsTbody;
    tbody.innerHTML = "";

    var paramedics = (cache.users || []).filter(function (u) {
      if ((u.status || "Approved") !== "Approved") return false;
      return u.isVolunteer || !isTraineeRole(u.role);
    });

    if (!paramedics.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 3;
      emptyCell.className = "empty-row";
      emptyCell.textContent = "אין פראמדיקים מוסמכים להצגה.";
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }

    paramedics.forEach(function (u) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = u.name;

      var tdKind = document.createElement("td");
      tdKind.textContent = u.isVolunteer ? "פראמדיק / מתנדב" : "צוות";

      var tdTutor = document.createElement("td");
      tdTutor.setAttribute("data-label", "טיוטור מאושר");
      var lbl = document.createElement("label");
      lbl.className = "switch";
      var box = document.createElement("input");
      box.type = "checkbox"; box.checked = !!u.isApprovedTutor;
      box.setAttribute("aria-label", "טיוטור מאושר — " + u.name);
      var track = document.createElement("span"); track.className = "switch-track";
      var txt = document.createElement("span");
      txt.className = "switch-text" + (u.isApprovedTutor ? " is-on" : " is-off");
      txt.textContent = u.isApprovedTutor ? "מאושר" : "לא";
      (function (userId) {
        box.addEventListener("change", function () { saveApprovedTutor(userId, box.checked, txt); });
      })(u.id);
      lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
      tdTutor.appendChild(lbl);

      tr.appendChild(tdName);
      tr.appendChild(tdKind);
      tr.appendChild(tdTutor);
      tbody.appendChild(tr);
    });
  }

  // Persist a paramedic's "טיוטור מאושר" flag. Updates the switch label in place
  // so the list isn't disrupted mid-edit.
  function saveApprovedTutor(userId, value, txt) {
    api("PATCH", "users/" + userId, { isApprovedTutor: value }).then(function () {
      (cache.users || []).forEach(function (u) { if (u.id === userId) u.isApprovedTutor = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "מאושר" : "לא";
      }
      toast(value ? "סומן כטיוטור מאושר" : "אישור הטיוטור הוסר", true);
    }).catch(function () { toast("העדכון נכשל", false); renderApprovedTutors(); });
  }

  /* ---------------- Manual tutors ("הוספת טיוטור ידני") ----------------
     A free-text tutor list kept separately from registered users. Admins add a
     name, toggle its approval in place, or remove it. Lives in the roster tab. */
  function loadManualTutors() {
    if (!isAdmin() || !el.manualTutorsTbody) return;
    api("GET", "manual-tutors").then(function (rows) {
      cache.manualTutors = rows || [];
      renderManualTutors();
      renderRoster();
    }).catch(function () {
      cache.manualTutors = [];
      renderManualTutors();
      renderRoster();
    });
  }

  function renderManualTutors() {
    if (!el.manualTutorsTbody) return;
    var tbody = el.manualTutorsTbody;
    tbody.innerHTML = "";
    var list = cache.manualTutors || [];

    if (!list.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 3;
      emptyCell.className = "empty-row";
      emptyCell.textContent = "לא נוספו טיוטורים ידניים.";
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }

    list.forEach(function (t) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = t.name;

      var tdTutor = document.createElement("td");
      tdTutor.setAttribute("data-label", "טיוטור מאושר");
      var lbl = document.createElement("label");
      lbl.className = "switch";
      var box = document.createElement("input");
      box.type = "checkbox"; box.checked = !!t.approved;
      box.setAttribute("aria-label", "טיוטור מאושר — " + t.name);
      var track = document.createElement("span"); track.className = "switch-track";
      var txt = document.createElement("span");
      txt.className = "switch-text" + (t.approved ? " is-on" : " is-off");
      txt.textContent = t.approved ? "מאושר" : "לא";
      (function (tutorId) {
        box.addEventListener("change", function () { saveManualTutorApproval(tutorId, box.checked, txt); });
      })(t.id);
      lbl.appendChild(box); lbl.appendChild(track); lbl.appendChild(txt);
      tdTutor.appendChild(lbl);

      var tdActions = document.createElement("td");
      tdActions.setAttribute("data-label", "פעולות");
      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm";
      del.textContent = "מחיקה";
      (function (tutorId, name) {
        del.addEventListener("click", function () { deleteManualTutor(tutorId, name); });
      })(t.id, t.name);
      tdActions.appendChild(del);

      tr.appendChild(tdName);
      tr.appendChild(tdTutor);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });
  }

  function onAddManualTutor(e) {
    e.preventDefault();
    if (!isAdmin() || !el.manualTutorName) return;
    var name = (el.manualTutorName.value || "").trim();
    if (!name) { toast("יש להזין שם טיוטור", false); return; }
    api("POST", "manual-tutors", { name: name }).then(function () {
      el.manualTutorName.value = "";
      loadManualTutors();
      toast("הטיוטור נוסף", true);
    }).catch(function () { toast("הוספת הטיוטור נכשלה", false); });
  }

  // Persist a manual tutor's approval flag, updating the switch label in place.
  function saveManualTutorApproval(tutorId, value, txt) {
    api("PATCH", "manual-tutors/" + tutorId, { approved: value }).then(function () {
      (cache.manualTutors || []).forEach(function (t) { if (t.id === tutorId) t.approved = value; });
      if (txt) {
        txt.className = "switch-text" + (value ? " is-on" : " is-off");
        txt.textContent = value ? "מאושר" : "לא";
      }
      renderRoster();
      toast(value ? "סומן כטיוטור מאושר" : "אישור הטיוטור הוסר", true);
    }).catch(function () { toast("העדכון נכשל", false); renderManualTutors(); });
  }

  function deleteManualTutor(tutorId, name) {
    if (!window.confirm("למחוק את הטיוטור \"" + name + "\"?")) return;
    api("DELETE", "manual-tutors/" + tutorId).then(function () {
      cache.manualTutors = (cache.manualTutors || []).filter(function (t) { return t.id !== tutorId; });
      renderManualTutors();
      renderRoster();
      toast("הטיוטור נמחק", true);
    }).catch(function () { toast("המחיקה נכשלה", false); });
  }

  /* ---------------- Forms checklist (טפסי חניכה) ---------------- */
  // Pull the master list of every assigned-trainee slot and its evaluation-form
  // status, then render. Server applies the visibility window and decides which
  // rows the current user is allowed to toggle (canToggle), so the client trusts
  // those flags rather than re-deriving authorization.
  function loadForms() {
    if (el.formsTbody) {
      el.formsTbody.innerHTML = "";
      var loadingRow = document.createElement("tr");
      var loadingCell = document.createElement("td");
      loadingCell.colSpan = 5;
      loadingCell.className = "empty-row";
      loadingCell.textContent = "טוען…";
      loadingRow.appendChild(loadingCell);
      el.formsTbody.appendChild(loadingRow);
    }
    if (el.trackingGroups && isAdmin()) {
      el.trackingGroups.innerHTML = '<div class="table-card"><p class="empty-row">טוען…</p></div>';
    }
    return api("GET", contextQuery("form-checklist")).then(function (data) {
      cache.formRows = (data && data.rows) || [];
      populateTraineeFilter();
      renderForms();
      renderTracking();
    }).catch(function () {
      cache.formRows = [];
      populateTraineeFilter();
      renderForms();
      renderTracking();
      toast("טעינת רשימת הטפסים נכשלה", false);
    });
  }

  // Admin-only: rebuild the trainee picker (in the tracking tab) from whoever
  // currently appears in the loaded rows, preserving the active selection when it
  // still exists.
  function populateTraineeFilter() {
    if (!el.trackingTraineeFilter || !isAdmin()) return;
    var prev = el.trackingTraineeFilter.value || "all";
    var seen = {};
    (cache.formRows || []).forEach(function (r) { if (r.trainee) seen[r.trainee] = true; });
    var names = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, "he"); });
    el.trackingTraineeFilter.innerHTML = "";
    var optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "כל החניכים";
    el.trackingTraineeFilter.appendChild(optAll);
    names.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      el.trackingTraineeFilter.appendChild(o);
    });
    el.trackingTraineeFilter.value = names.indexOf(prev) !== -1 ? prev : "all";
  }

  // "ד׳ 02/07/2026" — weekday initial + numeric date, matching the app's style.
  function formatChecklistDate(iso) {
    var p = iso.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return HE_WEEKDAYS_SHORT[d.getDay()] + " " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear();
  }

  // Whole days between a shift's date and today, as a Hebrew label for the admin's
  // pending-form worklist ("עברו X ימים"). A shift dated today reads "התקיימה
  // היום" and a still-future shift "טרם התקיימה", so the notice never shows a
  // nonsensical negative or zero count.
  function daysElapsedLabel(iso) {
    var p = (iso || "").split("-");
    if (p.length !== 3) return "";
    var shiftDay = new Date(+p[0], +p[1] - 1, +p[2]);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.round((today.getTime() - shiftDay.getTime()) / 86400000);
    if (diff < 0) return "טרם התקיימה";
    if (diff === 0) return "התקיימה היום";
    if (diff === 1) return "עבר יום אחד";
    return "עברו " + diff + " ימים";
  }

  // A checklist row needs no evaluation form when it is a non-shift event, when
  // the escort slot was flagged "לא נדרש טופס" at the shift level, or when it was
  // marked not-required directly on the checklist. Drives both the admin filter
  // (only form-required rows are shown) and the per-row UI (the form-status cell
  // stays intentionally blank when no form is needed).
  function formNotRequired(r) {
    return !!r.notRequired || !!r.noFormRequired || (!!r.taskType && r.taskType !== "shift");
  }

  // Build one table row for the personal ("המשמרות שלי") or the managerial
  // ("מעקב ביצוע טפסים") forms table. `opts.admin` switches on the worklist
  // styling — trainee and paramedic columns plus the "לא נדרש טופס" toggle and
  // an elapsed note; the personal view leaves those off and appends a Google-
  // calendar link. Column order matches each table's header: date, shift,
  // station, [trainee, paramedic], form, [calendar].
  function buildFormRow(r, opts) {
    opts = opts || {};
    var admin = !!opts.admin;
    var myName = (state.user && state.user.name || "").trim();

    var tr = document.createElement("tr");
    if (r.completed) tr.className = "is-done";

    var tdDate = document.createElement("td");
    tdDate.className = "forms-date";
    tdDate.textContent = formatChecklistDate(r.date);

    var tdShift = document.createElement("td");
    var pill = document.createElement("span");
    pill.className = "shift-pill";
    var dot = document.createElement("span");
    dot.className = "dot " + r.shift;
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(shiftLabel(r.shift)));
    tdShift.appendChild(pill);

    var tdStation = document.createElement("td");
    tdStation.textContent = r.station;
    // Shift note flag: if this shift carries admin guidance, show a red flag by
    // the station name so the reader opens the day to read the instructions.
    var rowNote = String(r.note || "").trim();
    if (rowNote) {
      var noteFlag = document.createElement("span");
      noteFlag.className = "shift-note-flag";
      noteFlag.setAttribute("role", "img");
      noteFlag.setAttribute("tabindex", "0");
      noteFlag.setAttribute("aria-label", "ראה הערות משמרת: " + rowNote);
      noteFlag.title = rowNote;
      noteFlag.textContent = "🚩";
      tdStation.appendChild(document.createTextNode(" "));
      tdStation.appendChild(noteFlag);
    }

    var tdForm = document.createElement("td");
    if (formNotRequired(r)) {
      // Intentionally blank: shifts without a required form render a clean,
      // empty status cell (no placeholder text).
      tdForm.className = "forms-blank-cell";
    } else {
      var label = document.createElement("label");
      label.className = "form-check" + (r.canToggle ? "" : " is-locked");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!r.completed;
      box.disabled = !r.canToggle;
      if (!r.canToggle) {
        label.title = "רק החניך/ה המשובץ/ת או מנהל יכולים לעדכן שורה זו";
      }
      var mark = document.createElement("span");
      mark.className = "form-check-text";
      mark.textContent = "בוצע טופס חניכה";
      label.appendChild(box);
      label.appendChild(mark);
      tdForm.appendChild(label);

      if (r.canToggle) {
        box.addEventListener("change", function () { toggleForm(r, box, mark, tr); });
      }

    }

    tr.appendChild(tdDate);
    tr.appendChild(tdShift);
    tr.appendChild(tdStation);

    // Managerial worklist carries a trainee-name column (with an "את/ה" tag when
    // the manager happens to be the assignee); the personal view does not — every
    // row there is the logged-in user's own shift.
    if (admin) {
      var tdTrainee = document.createElement("td");
      tdTrainee.textContent = r.trainee;
      if (r.trainee === myName) {
        var youTag = document.createElement("span");
        youTag.className = "you-tag";
        youTag.textContent = "את/ה";
        tdTrainee.appendChild(document.createTextNode(" "));
        tdTrainee.appendChild(youTag);
      }
      tr.appendChild(tdTrainee);

      var tdParamedic = document.createElement("td");
      tdParamedic.textContent = String(r.paramedicName || r.paramedic || r.instructorName || r.instructor || "").trim();
      tr.appendChild(tdParamedic);
    }

    tr.appendChild(tdForm);

    // "הוסף ליומן גוגל" per personal shift row — exports this shift as a prefilled
    // Google Calendar event using the row's own hours so start/end match exactly.
    if (!admin) {
      var tdCal = document.createElement("td");
      tdCal.className = "forms-cal";
      var calLink = buildGcalLink({
        iso: r.date, shift: r.shift, hours: r.hours || stationHoursFor(r.station, r.shift),
        station: r.station, slotLabel: slotLabelFor(r.slot), person: r.trainee
      }, false);
      if (calLink) tdCal.appendChild(calLink);
      tr.appendChild(tdCal);
    }

    return tr;
  }

  // "המשמרות שלי" — the logged-in user's OWN assigned shifts only. Trainee
  // tracking and the missing-forms analytics no longer live here; they moved to
  // the manager-only "מעקב ביצוע טפסים" tab (renderTracking).
  function renderForms() {
    if (!el.formsTbody) return;
    var rows = cache.formRows || [];
    var q = (el.formsSearch && el.formsSearch.value || "").trim().toLowerCase();
    var shiftFilter = (el.formsShiftFilter && el.formsShiftFilter.value) || "all";
    var statusFilter = (el.formsStatusFilter && el.formsStatusFilter.value) || "all";
    var myName = (state.user && state.user.name || "").trim();
    // Sunday (ISO) that starts the current week: a completed form older than this
    // drops off the personal list once the week has rolled past it.
    var currentWeekSunday = weekStartIso(todayIso());

    var filtered = rows.filter(function (r) {
      // Personal scope: ONLY the logged-in user's own shifts — enforced on the
      // client even for an admin (and under "view as" impersonation, where the
      // payload arrives as the full master list on the admin's token).
      if (r.trainee !== myName) return false;
      // Historical cleanup: a completed form from a previous week drops out; a
      // still-pending one stays visible no matter how old.
      if (r.completed && r.date < currentWeekSunday) return false;
      if (shiftFilter !== "all" && r.shift !== shiftFilter) return false;
      if (statusFilter === "done" && (formNotRequired(r) || !r.completed)) return false;
      if (statusFilter === "pending" && (formNotRequired(r) || r.completed)) return false;
      if (q) {
        var hay = (r.station + " " + r.date + " " + formatChecklistDate(r.date) + " " + shiftLabel(r.shift)).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    // Chronological order: earliest first, ties broken by station name.
    filtered.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.station.localeCompare(b.station);
    });

    el.formsTbody.innerHTML = "";

    if (filtered.length === 0) {
      var ownCount = rows.filter(function (r) { return r.trainee === myName; }).length;
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 5;
      emptyCell.className = "empty-row";
      emptyCell.textContent = ownCount === 0
        ? "אין לך משמרות משובצות להצגה."
        : "לא נמצאו שורות התואמות את הסינון.";
      emptyRow.appendChild(emptyCell);
      el.formsTbody.appendChild(emptyRow);
      return;
    }

    filtered.forEach(function (r) {
      el.formsTbody.appendChild(buildFormRow(r, { admin: false }));
    });
  }

  // "מעקב ביצוע טפסים" — managers only. A live worklist of every assigned-trainee
  // shift whose evaluation form is still required and not yet done, filterable by
  // trainee, shift type, status and free text, alongside the missing-forms report.
  function renderTracking() {
    if (el.missingFormsSection) el.missingFormsSection.hidden = true;
    if (!el.trackingGroups) return;
    if (!isAdmin()) { el.trackingGroups.innerHTML = ""; return; }
    var rows = cache.formRows || [];
    var q = (el.trackingSearch && el.trackingSearch.value || "").trim().toLowerCase();
    var shiftFilter = (el.trackingShiftFilter && el.trackingShiftFilter.value) || "all";
    var statusFilter = (el.trackingStatusFilter && el.trackingStatusFilter.value) || "all";
    var traineeFilter = (el.trackingTraineeFilter && el.trackingTraineeFilter.value) || "all";

    var filtered = rows.filter(function (r) {
      // Tracking scope: only rows whose shift still requires a form.
      if (formNotRequired(r)) return false;
      if (shiftFilter !== "all" && r.shift !== shiftFilter) return false;
      if (statusFilter === "done" && !r.completed) return false;
      if (statusFilter === "pending" && r.completed) return false;
      if (traineeFilter !== "all" && r.trainee !== traineeFilter) return false;
      if (q) {
        var hay = (r.trainee + " " + r.station + " " + r.date + " " + formatChecklistDate(r.date) + " " + shiftLabel(r.shift)).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    // Chronological order: earliest first, ties broken by station name.
    filtered.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.station.localeCompare(b.station);
    });

    var defs = [
      { key: "future", title: "משמרת שטרם התבצעה" },
      { key: "day1", title: "עד יום אחד" },
      { key: "day2", title: "עד שני ימים" },
      { key: "day3", title: "עד 3 ימים" },
      { key: "over3", title: "יותר מ-3 ימים" }
    ];
    var groups = { future: [], day1: [], day2: [], day3: [], over3: [] };
    filtered.forEach(function (r) {
      groups[trackingBucketKey(r)].push(r);
    });

    renderFormTrackingDashboard(defs, groups);
  }

  // Render the 5 time-bucket tracking groups as accordion cards.
  // Each card has a right-aligned title/subtitle/count cluster and a left
  // chevron button; body tables are hidden by default.
  function renderFormTrackingDashboard(defs, groups) {
    if (!el.trackingGroups) return;

    el.trackingGroups.innerHTML = "";
    defs.forEach(function (d) {
      var rows = groups[d.key] || [];
      var pending = rows.filter(function (r) { return !r.completed; }).length;

      var card = document.createElement("section");
      card.className = "table-card tracking-group-card";

      var head = document.createElement("button");
      head.type = "button";
      head.className = "tracking-group-head";
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", "false");
      head.setAttribute("aria-label", "פתיחה וסגירה של " + d.title);

      var meta = document.createElement("div");
      meta.className = "tracking-group-meta";

      var titleRow = document.createElement("div");
      titleRow.className = "tracking-group-title-row";

      var h = document.createElement("h3");
      h.className = "tracking-group-title";
      h.textContent = d.title;
      titleRow.appendChild(h);

      var count = document.createElement("span");
      count.className = "tracking-group-count";
      count.textContent = String(rows.length);
      titleRow.appendChild(count);

      var sub = document.createElement("p");
      sub.className = "tracking-group-sub";
      sub.textContent = pending + " פעילים מתוך " + rows.length;

      meta.appendChild(titleRow);
      meta.appendChild(sub);

      var arrow = document.createElement("span");
      arrow.className = "tracking-group-chevron";
      arrow.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';

      head.appendChild(meta);
      head.appendChild(arrow);
      card.appendChild(head);

      var body = document.createElement("div");
      body.className = "tracking-group-body hidden";

      var wrap = document.createElement("div");
      wrap.className = "tracking-group-table-wrap";

      var table = document.createElement("table");
      table.className = "users-table forms-table tracking-group-table";
      var thead = document.createElement("thead");
      thead.innerHTML = "<tr><th>תאריך</th><th>משמרת</th><th>תחנה</th><th>שם החניך</th><th>שם הפראמדיק</th><th>בוצע טופס חניכה</th></tr>";
      table.appendChild(thead);
      var tbody = document.createElement("tbody");

      if (!rows.length) {
        var emptyRow = document.createElement("tr");
        var emptyCell = document.createElement("td");
        emptyCell.colSpan = 6;
        emptyCell.className = "empty-row";
        emptyCell.textContent = "אין רשומות בקבוצה זו.";
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
      } else {
        rows.forEach(function (r) {
          tbody.appendChild(buildFormRow(r, { admin: true }));
        });
      }

      table.appendChild(tbody);
      wrap.appendChild(table);
      body.appendChild(wrap);
      card.appendChild(body);

      function toggleSection() {
        var isHidden = body.classList.contains("hidden");
        if (isHidden) {
          body.classList.remove("hidden");
          requestAnimationFrame(function () {
            body.classList.add("is-open");
          });
          head.setAttribute("aria-expanded", "true");
          arrow.classList.add("is-open");
          return;
        }

        body.classList.remove("is-open");
        head.setAttribute("aria-expanded", "false");
        arrow.classList.remove("is-open");
        window.setTimeout(function () {
          if (!body.classList.contains("is-open")) body.classList.add("hidden");
        }, 180);
      }

      head.addEventListener("click", toggleSection);
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSection();
        }
      });

      el.trackingGroups.appendChild(card);
    });
  }

  // Persist one checkbox toggle. Optimistic: flip the cached row immediately, and
  // roll back if the server rejects it (e.g. a stale row the user no longer owns).
  function toggleForm(row, box, mark, tr) {
    var want = box.checked;
    box.disabled = true;
    api("PUT", "form-checklist", {
      date: row.date, source: row.source, refId: row.refId, slot: row.slot, completed: want
    }).then(function () {
      row.completed = want;
      box.disabled = false;
      if (mark) mark.textContent = "בוצע טופס חניכה";
      if (tr) tr.classList.toggle("is-done", want);
      // Mirror the server-side counter move (+1 on complete, -1 on un-complete,
      // floored at 0) into the cached trainee so the admin roster's "מונה משמרות"
      // stays in step without waiting for the next users refresh.
      if (cache.users && row.trainee) {
        cache.users.forEach(function (u) {
          if (u.name !== row.trainee) return;
          var n = Number(u.shiftCount) || 0;
          u.shiftCount = Math.max(0, n + (want ? 1 : -1));
        });
      }
      // Keep both views consistent: a row may drop out after toggling. The admin
      // worklist shows only pending form-required rows (so a "בוצע" row must
      // disappear), and a status-filtered personal view behaves the same.
      renderForms();
      renderTracking();
    }).catch(function (err) {
      box.checked = !want; // revert the visual state
      box.disabled = false;
      if (err && err.status === 403) {
        toast("אין לך הרשאה לעדכן שורה זו", false);
      } else {
        toast("העדכון נכשל. נסו שוב", false);
      }
    });
  }

  // "דוח טפסים חסרים" — managers only. Built from the same cached checklist rows:
  // a shift is "missing its form" when a trainee is assigned, the form is not
  // marked completed AND it is not flagged "לא נדרש טופס".
  function renderMissingForms() {
    if (!el.missingFormsSection || !el.missingFormsTbody) return;
    if (!isAdmin()) { el.missingFormsSection.hidden = true; return; }
    el.missingFormsSection.hidden = false;

    var tbody = el.missingFormsTbody;
    tbody.innerHTML = "";
    var missing = (cache.formRows || []).filter(function (r) {
      return r.trainee && !r.completed && !formNotRequired(r);
    });
    missing.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.station.localeCompare(b.station);
    });

    if (!missing.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 5;
      emptyCell.className = "empty-row";
      emptyCell.textContent = "אין טפסים חסרים — כל המשמרות המשובצות מטופלות.";
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }

    missing.forEach(function (r) {
      var tr = document.createElement("tr");

      var tdDate = document.createElement("td");
      tdDate.className = "forms-date";
      tdDate.textContent = formatChecklistDate(r.date);

      var tdShift = document.createElement("td");
      var pill = document.createElement("span");
      pill.className = "shift-pill";
      var dot = document.createElement("span");
      dot.className = "dot " + r.shift;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(shiftLabel(r.shift)));
      tdShift.appendChild(pill);

      var tdStation = document.createElement("td");
      tdStation.textContent = r.station;

      var tdTrainee = document.createElement("td");
      tdTrainee.textContent = r.trainee;

      var tdNr = document.createElement("td");
      tdNr.setAttribute("data-label", "לא נדרש טופס");
      var nrLabel = document.createElement("label");
      nrLabel.className = "form-check";
      var nrBox = document.createElement("input");
      nrBox.type = "checkbox";
      nrBox.checked = false;
      var nrText = document.createElement("span");
      nrText.className = "form-check-text";
      nrText.textContent = "לא נדרש טופס";
      nrLabel.appendChild(nrBox);
      nrLabel.appendChild(nrText);
      tdNr.appendChild(nrLabel);
      nrBox.addEventListener("change", function () { toggleNotRequired(r, nrBox); });

      tr.appendChild(tdDate);
      tr.appendChild(tdShift);
      tr.appendChild(tdStation);
      tr.appendChild(tdTrainee);
      tr.appendChild(tdNr);
      tbody.appendChild(tr);
    });
  }

  // Persist the "לא נדרש טופס" flag for one slot. Optimistic + shared by the main
  // checklist and the missing-forms report; both re-render off the same cache.
  function toggleNotRequired(row, box) {
    var want = box.checked;
    box.disabled = true;
    api("PUT", "form-checklist", {
      date: row.date, source: row.source, refId: row.refId, slot: row.slot, notRequired: want
    }).then(function () {
      box.disabled = false;
      (cache.formRows || []).forEach(function (r) {
        if (r.date === row.date && r.source === row.source && r.refId === row.refId && r.slot === row.slot) {
          r.notRequired = want;
        }
      });
      renderForms();
      renderTracking();
      toast(want ? "סומן כלא נדרש טופס" : "הסימון הוסר", true);
    }).catch(function (err) {
      box.checked = !want;
      box.disabled = false;
      if (err && err.status === 403) {
        toast("אין לך הרשאה לעדכן שורה זו", false);
      } else {
        toast("העדכון נכשל. נסו שוב", false);
      }
    });
  }

  /* ---------------- Calendar ---------------- */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  // Render the logged-in user's own assignments into a day cell, one row per
  // station+shift (e.g. "רמת גן - בוקר"), ordered Night → Morning → Evening.
  // The month endpoint only ever returns the current user's assignments, so a
  // day with no rows is genuinely empty for them. Returns true if any was shown.
  function appendDayPreview(cell, assignments) {
    if (!assignments || !assignments.length) return false;
    var box = document.createElement("div");
    box.className = "day-preview";
    var ordered = assignments.slice().sort(function (a, b) {
      return shiftOrder(a.shift) - shiftOrder(b.shift);
    });
    ordered.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "day-shift " + a.shift;
      var band = document.createElement("span");
      band.className = "day-shift-band";
      var label = document.createElement("span");
      label.className = "day-shift-names";
      var text = a.station + " - " + shiftLabel(a.shift);
      label.textContent = text;
      label.title = text;
      row.appendChild(band);
      row.appendChild(label);
      // Red flag when this shift carries admin guidance, mirroring the day detail
      // and "My Shifts" indicators so a note is visible straight from the grid.
      var noteText = String(a.note || "").trim();
      if (noteText) {
        var flag = document.createElement("span");
        flag.className = "shift-note-flag";
        flag.setAttribute("role", "img");
        flag.setAttribute("aria-label", "ראה הערות משמרת: " + noteText);
        flag.title = noteText;
        flag.textContent = "🚩";
        row.appendChild(flag);
      }
      box.appendChild(row);
    });
    cell.appendChild(box);
    return true;
  }

  function stepMonth(delta) {
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + delta, 1);
    state.selectedDate = null;
    el.dayDetail.hidden = true;
    loadMonth();
  }

  // Fetch the set of days in the visible month that carry an assignment, then
  // (re)render the calendar grid.
  function loadMonth() {
    var y = state.viewDate.getFullYear(), m = state.viewDate.getMonth();
    var month = y + "-" + pad(m + 1);
    return refreshStations().then(function () {
      return api("GET", contextQuery("schedules?month=" + month));
    }).then(function (d) {
      cache.monthDates = {};
      cache.monthDays = (d && d.days) || {};
      (d.dates || []).forEach(function (iso) { cache.monthDates[iso] = true; });
      renderCalendar();
    }).catch(function () {
      cache.monthDates = {};
      cache.monthDays = {};
      renderCalendar();
    });
  }

  function renderCalendar() {
    var y = state.viewDate.getFullYear();
    var m = state.viewDate.getMonth();
    el.monthLabel.textContent = HE_MONTHS[m] + " " + y;

    el.weekdays.innerHTML = "";
    HE_WEEKDAYS_SHORT.forEach(function (w) {
      var s = document.createElement("span");
      s.textContent = w;
      el.weekdays.appendChild(s);
    });

    el.grid.innerHTML = "";
    var firstDay = new Date(y, m, 1).getDay(); // 0=Sunday
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var today = new Date();
    var isCurMonth = today.getFullYear() === y && today.getMonth() === m;

    for (var b = 0; b < firstDay; b++) {
      var blank = document.createElement("div");
      blank.className = "day-cell is-empty";
      el.grid.appendChild(blank);
    }

    for (var d = 1; d <= daysInMonth; d++) {
      var iso = y + "-" + pad(m + 1) + "-" + pad(d);

      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "day-cell";
      if (isCurMonth && today.getDate() === d) cell.classList.add("is-today");
      if (state.selectedDate === iso) cell.classList.add("is-selected");

      var num = document.createElement("span");
      num.className = "day-num";
      num.textContent = d;
      cell.appendChild(num);

      if (isExposurePending(iso)) {
        // The coming week hasn't reached its exposure-release time yet: show the
        // "will be published soon" placeholder with the release time, and refuse
        // to open the day. Distinct from the un-published lock below.
        cell.classList.add("is-locked");
        cell.setAttribute("aria-disabled", "true");
        cell.title = "הסידור לשבוע הקרוב יפורסם בקרוב (" + exposureReleaseLabel(iso) + ")";
        var soon = document.createElement("span");
        soon.className = "day-locked-note";
        soon.textContent = "הסידור לשבוע הקרוב יפורסם בקרוב";
        cell.appendChild(soon);
        cell.addEventListener("click", function () {
          toast("הסידור לשבוע הקרוב יפורסם בקרוב", false);
        });
      } else if (isDayLockedForViewer(iso)) {
        // Outside the published week for a trainee: lock the cell behind a
        // placeholder, blur away any preview, and refuse to open the day.
        cell.classList.add("is-locked");
        cell.setAttribute("aria-disabled", "true");
        cell.title = "הסידור לשבוע זה טרם פורסם";
        var note = document.createElement("span");
        note.className = "day-locked-note";
        note.textContent = "הסידור לשבוע זה טרם פורסם";
        cell.appendChild(note);
        cell.addEventListener("click", function () {
          toast("הסידור לשבוע זה טרם פורסם", false);
        });
      } else {
        // Personalized preview: only the logged-in user's own assignments. Days
        // where they are not scheduled stay clean and empty.
        appendDayPreview(cell, cache.monthDays[iso]);
        (function (isoDate) {
          cell.addEventListener("click", function () { selectDay(isoDate); });
        })(iso);
      }

      el.grid.appendChild(cell);
    }
  }

  function selectDay(iso) {
    // The coming week stays hidden until its exposure-release time.
    if (isExposurePending(iso)) { toast("הסידור לשבוע הקרוב יפורסם בקרוב", false); return; }
    // Trainees can't open days outside the published visibility window.
    if (isDayLockedForViewer(iso)) { toast("הסידור לשבוע זה טרם פורסם", false); return; }
    state.selectedDate = iso;
    renderCalendar();
    Promise.all([refreshStations(), loadDay(iso)]).then(function () {
      if (state.selectedDate !== iso) return; // user moved on while loading
      renderDayDetail(iso);
      el.dayDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  // Load the schedule + availability for a single day into the cache.
  function loadDay(iso) {
    return Promise.all([
      api("GET", contextQuery("schedules/" + iso)).catch(function () { return { shifts: {} }; }),
      api("GET", "availability/" + iso).catch(function () { return { entries: [] }; })
    ]).then(function (res) {
      cache.day = {
        iso: iso,
        shifts: (res[0] && res[0].shifts) || {},
        hidden: (res[0] && res[0].hidden) || [],
        custom: (res[0] && res[0].custom) || [],
        availEntries: (res[1] && res[1].entries) || []
      };
    });
  }

  /* ---------------- Day detail / shift tables ---------------- */
  function renderDayDetail(iso) {
    var parts = iso.split("-");
    var y = +parts[0], m = +parts[1] - 1, d = +parts[2];
    var dateObj = new Date(y, m, d);
    var saved = { shifts: (cache.day && cache.day.iso === iso) ? cache.day.shifts : {} };
    // Schedule editing is gated specifically on canEditSchedule; viewers and
    // trainees see the day read-only. `canEdit` is the privilege (unmasked crew,
    // availability matrix, exports) while `admin` — the flag every field checks to
    // decide whether it is interactive — additionally requires the admin to have
    // flipped the "מצב עריכה" switch on. With the switch off the board is a clean,
    // click-safe read-only view even for an editor, preventing stray edits.
    var canEdit = canEditSchedule();
    var admin = canEdit && state.scheduleEditMode;
    var locked = isAvailLocked(iso);

    el.dayDetail.hidden = false;
    el.dayDetail.innerHTML = "";
    updateStickyOffset(); // keep the pinned day header clear of the live topbar height
    closeAssignPicker(); // drop any popover left over from a previous render
    closeNameMenu();
    clearRevealTimer();  // and any pending auto-unmask scheduled by a previous render

    // Soonest moment (ms epoch) at which a masked crew name on this day becomes
    // visible; we schedule a single re-render then so names appear on their own.
    var nextReveal = null;
    function noteReveal(at) {
      if (at != null && at > Date.now() && (nextReveal == null || at < nextReveal)) nextReveal = at;
    }

    var head = document.createElement("div");
    head.className = "detail-head";
    var titleWrap = document.createElement("div");
    var h3 = document.createElement("h3");
    h3.textContent = "יום " + HE_WEEKDAYS[dateObj.getDay()] + ", " + d + " ב" + HE_MONTHS[m] + " " + y;
    var sub = document.createElement("div");
    sub.className = "detail-sub";
    // The read-only warning is shown only while an editor is in view mode; the
    // moment edit mode is on we drop the line entirely to keep the board clean.
    if (canEdit && admin) {
      sub.hidden = true;
    } else {
      sub.textContent = canEdit
        ? "מצב צפייה בלבד — לחצו על סמל העיפרון כדי לערוך ולשבץ."
        : (locked ? "הגשת האילוצים לשבוע זה ננעלה" : "דרגו את העדפת השיבוץ שלכם והגישו אילוצים");
    }
    titleWrap.appendChild(h3); titleWrap.appendChild(sub);

    var actions = document.createElement("div");
    actions.className = "detail-actions";
    // Admin edit-mode pencil: an editor lands on the day read-only and clicks
    // the pencil to unlock the fields. Toggling re-renders the whole board so
    // every slot, picker and panel rebuilds in its correct state; the pencil
    // highlights while edit mode is active.
    if (canEdit) {
      actions.appendChild(buildEditPencil(admin, function () {
        state.scheduleEditMode = !state.scheduleEditMode;
        renderDayDetail(iso);
      }));
      // Global undo — reverts the last scheduling change from either tab.
      actions.appendChild(buildUndoButton());
    }
    if (admin) {
      // Auto-save replaces the old manual "שמור שיבוץ" button: every field change
      // persists on its own (see scheduleAutoSave), and this inline pill reports the
      // live status — שומר... / נשמר אוטומטית / failure — at the top of the board.
      autosaveEl = document.createElement("span");
      autosaveEl.className = "autosave-status is-idle";
      autosaveEl.setAttribute("role", "status");
      autosaveEl.setAttribute("aria-live", "polite");
      autosaveEl.hidden = true;
      actions.appendChild(autosaveEl);
    } else {
      autosaveEl = null;
    }
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn btn-close-detail";
    closeBtn.textContent = "סגירה";
    closeBtn.addEventListener("click", function () {
      closeAssignPicker();
      closeNameMenu();
      clearRevealTimer();
      el.dayDetail.hidden = true;
      state.selectedDate = null;
      renderCalendar();
    });
    actions.appendChild(closeBtn);

    head.appendChild(titleWrap);
    head.appendChild(actions);
    el.dayDetail.appendChild(head);

    // Targeted deployment notes for this exact day: a trainee sees only their own
    // (the API scopes them), staff see everyone deployed elsewhere on this date.
    var pBanner = buildPlacementDayBanner(iso);
    if (pBanner) el.dayDetail.appendChild(pBanner);

    if (canEdit) {
      el.dayDetail.appendChild(buildAvailMatrix(iso));
    } else {
      el.dayDetail.appendChild(buildAvailForm(iso, locked));
    }

    var wrap = document.createElement("div");
    wrap.className = "shifts";

    // Stations the admin removed from this specific day. Hidden for everyone on
    // this date; admins also get a panel below to restore them.
    var hiddenIds = (cache.day && cache.day.iso === iso && cache.day.hidden) || [];
    var hiddenSet = {};
    hiddenIds.forEach(function (sid) { hiddenSet[sid] = true; });

    // Build one chronologically-ordered list (Night → Morning → Evening) that
    // merges the global stations active for this day with any per-day custom
    // shifts the admin added on the fly. Both render and save identically through
    // the same card; only their persistence target differs (see collectDayPayload).
    var customList = (cache.day && cache.day.iso === iso && cache.day.custom) || [];
    var rows = [];
    (cache.stations || []).forEach(function (s) {
      if (!canSeeStationRow(s)) return;
      if (hiddenSet[s.id]) return; // removed from this day — skip it
      rows.push({
        id: s.id, dbId: s.id, isCustom: false,
        name: s.name, shift: s.shift, hours: s.hours,
        saved: (saved.shifts && saved.shifts[s.id]) || {}
      });
    });
    customList.forEach(function (c) {
      if (!canSeeStationRow(c)) return;
      rows.push({
        id: "c" + c.id, dbId: c.id, isCustom: true,
        name: c.name, shift: c.shift, hours: c.hours,
        saved: { driver: c.driver, medic: c.medic, intern1: c.intern1, intern2: c.intern2, note: c.note, taskType: c.taskType, trainees: c.trainees }
      });
    });
    rows.sort(function (a, b) { return shiftOrder(a.shift) - shiftOrder(b.shift); });

    // Mobile-first accordion: rather than dumping the whole crew matrix at once,
    // the day opens as three wide, light trigger buttons — Night → Morning →
    // Evening (SHIFT_TYPES order) — and each one expands only its own shifts when
    // tapped. The cards are built exactly as before but dropped into their shift's
    // collapsible body; every card stays in the DOM even while its section is
    // closed, so the delegated autosave on `wrap` and collectDayPayload (which
    // reads fields by id) keep working no matter which sections are open.
    var groupBodies = {};
    SHIFT_TYPES.forEach(function (t) {
      var count = 0;
      rows.forEach(function (r) { if (r.shift === t.id) count++; });
      if (!count) return; // no stations of this type on this day — no button

      var section = document.createElement("div");
      section.className = "shift-acc shift-acc-" + t.id;

      var trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "shift-acc-trigger";
      trigger.setAttribute("aria-expanded", "false");
      trigger.innerHTML =
        '<span class="shift-acc-band ' + t.id + '"></span>' +
        '<span class="shift-acc-title"></span>' +
        '<span class="shift-acc-count"></span>' +
        '<svg class="shift-acc-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';
      trigger.querySelector(".shift-acc-title").textContent = t.label;
      trigger.querySelector(".shift-acc-count").textContent = count + (count === 1 ? " משמרת" : " משמרות");

      var body = document.createElement("div");
      body.className = "shift-acc-body";
      var inner = document.createElement("div");
      inner.className = "shift-acc-inner";
      body.appendChild(inner);

      trigger.addEventListener("click", function () {
        var open = section.classList.toggle("is-open");
        trigger.setAttribute("aria-expanded", open ? "true" : "false");
      });

      section.appendChild(trigger);
      section.appendChild(body);
      wrap.appendChild(section);
      groupBodies[t.id] = inner;
    });

    if (rows.length === 0) {
      var emptyMsg = document.createElement("p");
      emptyMsg.className = "shifts-empty";
      if ((cache.stations || []).length === 0) {
        emptyMsg.textContent = admin
          ? "לא הוגדרו תחנות פעילות. ניתן להגדיר תחנות קבועות במסך “ניהול תחנות ומשמרות”, או להוסיף משמרת נקודתית ליום זה למטה."
          : "אין משמרות פעילות ליום זה.";
      } else {
        emptyMsg.textContent = admin
          ? "כל המשמרות הוסרו מיום זה. ניתן לשחזר אותן מהרשימה שלמטה או להוסיף משמרת נקודתית."
          : "אין משמרות פעילות ליום זה.";
      }
      wrap.appendChild(emptyMsg);
    }

    rows.forEach(function (shift) {
      var savedShift = shift.saved || {};

      var card = document.createElement("div");
      card.className = "shift-card" + (shift.isCustom ? " is-custom" : "");

      var cardHead = document.createElement("div");
      cardHead.className = "shift-card-head";
      cardHead.innerHTML =
        '<span class="shift-band ' + shift.shift + '"></span>' +
        '<span class="shift-name"></span>' +
        '<span class="shift-time"></span>';
      cardHead.querySelector(".shift-name").textContent = shift.name;
      cardHead.querySelector(".shift-time").textContent = shift.hours;

      // Note flag: when this shift carries free-text guidance, surface a small
      // red flag next to the shift name so trainees don't miss the instructions.
      // Hovering (or focusing) it reveals the note text itself.
      var noteText = String(savedShift.note || "").trim();
      if (noteText) {
        var flag = document.createElement("span");
        flag.className = "shift-note-flag";
        flag.setAttribute("role", "img");
        flag.setAttribute("tabindex", "0");
        flag.setAttribute("aria-label", "ראה הערות משמרת: " + noteText);
        flag.title = noteText;
        flag.textContent = "🚩";
        cardHead.querySelector(".shift-name").insertAdjacentElement("afterend", flag);
      }

      // A per-day custom shift gets a small badge so it reads as a one-off
      // addition for this date, not a permanent station.
      if (shift.isCustom) {
        var tag = document.createElement("span");
        tag.className = "shift-custom-tag";
        tag.textContent = "משמרת נקודתית";
        cardHead.querySelector(".shift-time").insertAdjacentElement("afterend", tag);
      }

      // Admin: remove this exact station/shift row from this day only. Stations
      // are hidden (and can be restored); a custom shift is deleted outright. The
      // confirmation escalates when the slot already holds assignments.
      if (admin) {
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-shift-del";
        delBtn.title = "מחיקת משמרת זו מהיום";
        delBtn.setAttribute("aria-label", "מחיקת המשמרת " + shift.name + " - " + shiftLabel(shift.shift) + " מיום זה");
        delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
          '<path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/></svg>' +
          '<span>מחק משמרת</span>';
        (function (st) {
          delBtn.addEventListener("click", function () {
            if (st.isCustom) deleteCustomShift(iso, st);
            else hideShift(iso, st);
          });
        })(shift);
        cardHead.appendChild(delBtn);
      }
      card.appendChild(cardHead);

      // "סוג המשימה" selector. A 'shift' shows the standard crew grid; any event
      // type ('יום תרגול / עיון' / 'טקס' / 'אחר') swaps it for the trainee list
      // built below. Admins choose from the dropdown; a viewer just sees a badge
      // naming the event (nothing extra for a plain shift).
      var taskType = knownTaskType(savedShift.taskType);
      var taskSel = null;
      if (admin) {
        var taskRow = document.createElement("div");
        taskRow.className = "task-type-row";
        var taskTypeId = "f_" + shift.id + "_tasktype";
        var taskLabel = document.createElement("label");
        taskLabel.setAttribute("for", taskTypeId);
        taskLabel.textContent = "סוג המשימה";
        taskSel = document.createElement("select");
        taskSel.id = taskTypeId;
        taskSel.className = "task-type-select";
        taskSel.setAttribute("data-slot", "tasktype");
        TASK_TYPES.forEach(function (t) {
          var o = document.createElement("option");
          o.value = t.id;
          o.textContent = t.label;
          if (t.id === taskType) o.selected = true;
          taskSel.appendChild(o);
        });
        taskRow.appendChild(taskLabel);
        taskRow.appendChild(taskSel);
        card.appendChild(taskRow);
      } else if (taskType !== "shift") {
        var taskBadge = document.createElement("div");
        taskBadge.className = "task-type-badge";
        taskBadge.textContent = taskTypeLabel(taskType);
        card.appendChild(taskBadge);
      }

      var slotGrid = document.createElement("div");
      slotGrid.className = "slot-grid";

      SLOTS.forEach(function (slot) {
        var fieldId = "f_" + shift.id + "_" + slot.key;
        var listId = "dl_" + shift.id + "_" + slot.key;
        var cell = document.createElement("div");
        cell.className = "slot";

        var label = document.createElement("label");
        label.setAttribute("for", fieldId);
        label.innerHTML = '<span class="slot-role-dot ' + slot.role + '"></span>' + slot.label;
        cell.appendChild(label);

        var box = document.createElement("div");
        box.className = "combo";

        var input = document.createElement("input");
        input.type = "text";
        input.id = fieldId;
        input.className = "combo-input";
        input.setAttribute("list", listId);
        input.setAttribute("data-shift", shift.id);
        input.setAttribute("data-slot", slot.key);
        input.setAttribute("autocomplete", "off");
        input.placeholder = "בחר/י מהרשימה או הקלד/י שם";
        // Time-released crew masking: for trainee / view-only accounts the
        // driver and paramedic names stay hidden behind a placeholder until the
        // reveal window opens; everyone keeps seeing their own real value once
        // it does (and admins/demo always do).
        var crewMasked = !canEdit && isCrewRole(slot.role) && isCrewMasked(iso, shift.shift, shift.hours);
        if (crewMasked) {
          input.value = crewMaskText();
          input.classList.add("is-crew-masked");
          input.setAttribute("aria-label", slot.label + " — " + crewMaskText());
          noteReveal(crewRevealAt(iso, shift.shift, shift.hours));
        } else {
          input.value = savedShift[slot.key] || "";
        }
        if (!admin) input.disabled = true; // viewer = read only

        var dl = document.createElement("datalist");
        dl.id = listId;
        comboNames().forEach(function (person) {
          var o = document.createElement("option");
          o.value = person;
          dl.appendChild(o);
        });

        box.appendChild(input);
        box.appendChild(dl);

        // Smart assignment: an admin-only shortcut on trainee slots that opens a
        // picker of trainees ranked by their submitted availability for this
        // date + shift type, and places the chosen one with a single click.
        if (admin && slot.role === "intern") {
          var assignBtn = document.createElement("button");
          assignBtn.type = "button";
          assignBtn.className = "btn-assign";
          assignBtn.textContent = "שבץ חניך";
          assignBtn.title = "שיבוץ חניך/ה לפי זמינות שהוגשה";
          (function (st, sl, b) {
            b.addEventListener("click", function () { openAssignPicker(b, iso, st, sl); });
          })(shift, slot, assignBtn);
          box.appendChild(assignBtn);
        }

        cell.appendChild(box);

        // "הוסף ליומן גוגל": once a slot holds a visible assigned name, anyone
        // viewing the board (admin, trainee or tutor) gets a compact calendar
        // icon that exports this exact shift as a prefilled Google Calendar event.
        // Skipped while the crew name is still masked (nothing to export yet).
        var assignedName = crewMasked ? "" : (savedShift[slot.key] || "").trim();
        if (assignedName) {
          var gcal = buildGcalLink({
            iso: iso, shift: shift.shift, hours: shift.hours, station: shift.name,
            slotLabel: slot.label, person: assignedName
          }, true);
          if (gcal) box.appendChild(gcal);
        }

        // Slot-level mentoring-form status line:
        // show only for assigned users that are dynamically marked as
        // requiring mentoring forms. Empty/non-enabled slots render no box.
        if (slot.role === "intern" && canSeeNoForm() && assignedName) {
          var assignedUser = findAssignedUserByName(assignedName);
          if (userRequiresMentoringForm(assignedUser)) {
            var formRow = findFormChecklistRow(iso, shift, slot.key);
            var formLabel = document.createElement("label");
            formLabel.className = "form-check noform-toggle-slot";
            var formBox = document.createElement("input");
            formBox.type = "checkbox";
            formBox.checked = !!(formRow && formRow.completed);
            formBox.disabled = !formRow || !formRow.canToggle;
            var formText = document.createElement("span");
            formText.className = "form-check-text";
            formText.textContent = "בוצע טופס חניכה";
            formLabel.appendChild(formBox);
            formLabel.appendChild(formText);
            cell.appendChild(formLabel);
            if (formRow && formRow.canToggle) {
              formBox.addEventListener("change", function () {
                toggleForm(formRow, formBox, formText, null);
              });
            }
          }
        }

        slotGrid.appendChild(cell);
      });

      var noteCell = document.createElement("div");
      noteCell.className = "slot";
      var noteId = "f_" + shift.id + "_note";
      var noteLabel = document.createElement("label");
      noteLabel.setAttribute("for", noteId);
      noteLabel.innerHTML = '<span class="slot-role-dot" style="background:var(--ink-faint)"></span>הערות משמרת';
      var noteInput = document.createElement("input");
      noteInput.type = "text";
      noteInput.id = noteId;
      noteInput.setAttribute("data-shift", shift.id);
      noteInput.setAttribute("data-slot", "note");
      noteInput.placeholder = "רכב / נקודת התייצבות / הערה";
      noteInput.value = savedShift.note || "";
      if (!admin) noteInput.disabled = true;
      noteCell.appendChild(noteLabel);
      noteCell.appendChild(noteInput);
      var noteGrid = document.createElement("div");
      noteGrid.className = "slot-grid note-only";
      noteGrid.appendChild(noteCell);

      // Event task types (training / ceremony / other) replace the crew grid with
      // a stacked, admin-managed list of trainees ("משתלמים"). Both layouts are
      // built and one is shown per the current task type; switching the dropdown
      // toggles them live and persists the choice.
      var traineeGrid = buildTraineeList(iso, admin, shift, Array.isArray(savedShift.trainees) ? savedShift.trainees : []);
      function applyTaskLayout() {
        var isShift = (taskSel ? taskSel.value : taskType) === "shift";
        slotGrid.style.display = isShift ? "" : "none";
        traineeGrid.style.display = isShift ? "none" : "";
      }
      applyTaskLayout();
      if (taskSel) {
        taskSel.addEventListener("change", function () {
          applyTaskLayout();
          scheduleAutoSave(iso);
        });
      }

      card.appendChild(slotGrid);
      card.appendChild(traineeGrid);
      card.appendChild(noteGrid);
      // Drop the card into its shift's collapsible body (Night/Morning/Evening);
      // fall back to `wrap` if for any reason no group was built for this type.
      (groupBodies[shift.shift] || wrap).appendChild(card);
    });

    el.dayDetail.appendChild(wrap);

    // Auto-save: any change to an assignment field in the board — driver / medic /
    // trainee combos, the shift note, or the per-escort "ללא טופס" checkbox — flushes
    // the whole day to the server. Every such field carries data-shift, and they all
    // live inside `wrap`, so one delegated listener covers current and custom shifts
    // alike. The "שבץ חניך" picker persists on its own (see quickAssign), so it is
    // intentionally not routed through here.
    if (admin) {
      wrap.addEventListener("change", function (e) {
        var t = e.target;
        if (t && t.hasAttribute && t.hasAttribute("data-shift")) scheduleAutoSave(iso);
      });
    }

    // WhatsApp export: a separate, single-shift roster per shift type present on
    // this day. There is deliberately NO consolidated "all shifts" button —
    // each button captures only its own shift context (בוקר / ערב / לילה) and
    // copies that clean single-shift block to the clipboard. Restricted to
    // admins / authorized coordinators (anyone who may edit the schedule or
    // manage roles); trainees (משתלמים/חניכים) never see or trigger the export.
    if (rows.length && isAdmin()) {
      var waBar = document.createElement("div");
      waBar.className = "wa-export";

      // Distinct shift types in the order rows arrive (Night → Morning → Evening).
      var seenShift = {};
      rows.forEach(function (row) {
        if (seenShift[row.shift]) return;
        seenShift[row.shift] = true;

        var waBtn = document.createElement("button");
        waBtn.type = "button";
        waBtn.className = "btn btn-wa";
        waBtn.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
          '<path fill="currentColor" d="M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.4A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.1 14.9l-.3-.2-2.8.8.8-2.7-.2-.3A8 8 0 0 1 12 4zm-2.7 4.2c-.2 0-.5 0-.7.3-.3.3-1 .9-1 2.2s1 2.6 1.2 2.8c.1.2 2 3.1 5 4.3 2.4 1 2.9.8 3.5.8.5-.1 1.7-.7 2-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.2-.7.1l-.7.9c-.1.2-.3.2-.5.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.1-.3 0-.4.1-.6l.5-.5c.1-.2.2-.3.3-.5 0-.2 0-.4-.1-.5l-.9-2.2c-.2-.5-.4-.5-.6-.5z"/></svg>' +
          '<span>העתקת ' + shiftLabel(row.shift) + ' לוואטסאפ</span>';
        (function (st, dt, b) {
          b.addEventListener("click", function () { copyWhatsapp(st, rows, dt, b); });
        })(row.shift, dateObj, waBtn);
        waBar.appendChild(waBtn);
      });

      el.dayDetail.appendChild(waBar);
    }

    // Admin restore panel: every station hidden from this day, each with a
    // one-click restore so removals are never a dead end.
    if (admin && hiddenIds.length) {
      var hiddenStations = (cache.stations || []).filter(function (s) { return hiddenSet[s.id]; });
      var panel = document.createElement("div");
      panel.className = "hidden-shifts";
      var ph = document.createElement("div");
      ph.className = "hidden-shifts-head";
      ph.textContent = "משמרות שהוסרו מיום זה";
      panel.appendChild(ph);

      var list = document.createElement("div");
      list.className = "hidden-shifts-list";
      hiddenStations.forEach(function (st) {
        var chip = document.createElement("div");
        chip.className = "hidden-chip";
        var band = document.createElement("span");
        band.className = "shift-band " + st.shift;
        var lbl = document.createElement("span");
        lbl.className = "hidden-chip-label";
        lbl.textContent = st.name + " · " + shiftLabel(st.shift);
        var restore = document.createElement("button");
        restore.type = "button";
        restore.className = "btn-restore-shift";
        restore.textContent = "שחזור";
        restore.setAttribute("aria-label", "שחזור המשמרת " + st.name + " - " + shiftLabel(st.shift));
        (function (station) {
          restore.addEventListener("click", function () { restoreShift(iso, station); });
        })(st);
        chip.appendChild(band);
        chip.appendChild(lbl);
        chip.appendChild(restore);
        list.appendChild(chip);
      });
      panel.appendChild(list);
      el.dayDetail.appendChild(panel);
    }

    // Admin: add a one-off custom shift to this date. Lives at the very bottom of
    // the day view; on save it slots into the grid above in chronological order.
    if (admin) {
      el.dayDetail.appendChild(buildAddCustomShift(iso));
    }

    // Auto-reveal: if any crew name on this day is still masked, re-render the
    // day exactly when the soonest reveal window opens so the names appear with
    // no manual refresh. One timer covers the whole day (the earliest reveal).
    // Only armed when the reveal is within the next 12 hours — anything further
    // out is refreshed on the next navigation, which also keeps the delay well
    // inside setTimeout's safe range (no overflow / immediate-fire loop).
    if (nextReveal != null) {
      var delay = nextReveal - Date.now();
      if (delay <= 12 * 3600000) {
        state.revealTimer = window.setTimeout(function () {
          state.revealTimer = null;
          if (state.selectedDate === iso && el.dayDetail && !el.dayDetail.hidden) renderDayDetail(iso);
        }, Math.max(1000, delay));
      }
    }
  }

  function normalizeWhiteAmbulanceDate() {
    var pick = state.whiteAmbulanceDate || state.selectedDate || todayIso();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pick || ""))) pick = todayIso();
    state.whiteAmbulanceDate = pick;
    var parts = pick.split("-");
    state.whiteViewDate = new Date(+parts[0], (+parts[1] || 1) - 1, 1);
    if (el.whiteAmbulanceDate) el.whiteAmbulanceDate.value = pick;
    if (el.whiteImportDate) el.whiteImportDate.value = pick;
    return pick;
  }

  function whiteMonthStr() {
    return state.whiteViewDate.getFullYear() + "-" + pad(state.whiteViewDate.getMonth() + 1);
  }

  function stepWhiteMonth(delta) {
    state.whiteViewDate = new Date(state.whiteViewDate.getFullYear(), state.whiteViewDate.getMonth() + delta, 1);
    if (el.tabWhiteMonthly && !el.tabWhiteMonthly.hidden) loadWhiteMonthly();
    else if (el.tabWhiteImport && !el.tabWhiteImport.hidden) loadWhiteImportPanel();
    else loadWhiteAmbulancePanel();
  }

  function loadWhitePrivateMonth() {
    var month = whiteMonthStr();
    return api("GET", "schedules?privateDaily=" + month).then(function (d) {
      cache.whiteMonthDates = {};
      cache.whiteMonthByDate = (d && d.byDate) || {};
      (d && d.dates || []).forEach(function (iso) { cache.whiteMonthDates[iso] = true; });
      return d;
    }).catch(function () {
      cache.whiteMonthDates = {};
      cache.whiteMonthByDate = {};
      return { month: month, dates: [], byDate: {} };
    });
  }

  function onWhiteAmbulanceDateChange() {
    if (!isWhiteAmbulanceAdmin()) return;
    var value = el.whiteAmbulanceDate && el.whiteAmbulanceDate.value;
    state.whiteAmbulanceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value : todayIso();
    var parts = state.whiteAmbulanceDate.split("-");
    state.whiteViewDate = new Date(+parts[0], (+parts[1] || 1) - 1, 1);
    if (el.tabWhiteImport && !el.tabWhiteImport.hidden) loadWhiteImportPanel();
    else loadWhiteAmbulancePanel();
  }

  function onWhiteImportDateChange() {
    if (!isWhiteAmbulanceAdmin()) return;
    var value = el.whiteImportDate && el.whiteImportDate.value;
    state.whiteAmbulanceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value : todayIso();
    var parts = state.whiteAmbulanceDate.split("-");
    state.whiteViewDate = new Date(+parts[0], (+parts[1] || 1) - 1, 1);
    if (el.whiteAmbulanceDate) el.whiteAmbulanceDate.value = state.whiteAmbulanceDate;
    loadWhiteImportPanel();
  }

  function loadWhiteAmbulancePanel() {
    if (!isWhiteAmbulanceAdmin() || !el.whiteAmbulanceGrid) return Promise.resolve();
    var iso = normalizeWhiteAmbulanceDate();
    el.whiteAmbulanceGrid.innerHTML = '<p class="engine-empty">טוען לוח אמבולנס לבן…</p>';
    if (el.whiteRequestDate) el.whiteRequestDate.value = iso;
    return Promise.all([
      loadWhitePrivateMonth().catch(function () { return { byDate: {} }; }),
      loadWhiteStations(),
      api("GET", "schedules/" + iso + "?context=white-ambulance").catch(function () { return { shifts: {} }; }),
      loadWhiteRequests(),
    ]).then(function (res) {
      renderWhiteCalendar();
      var day = res[2] || { shifts: {} };
      cache.whiteDay = { iso: iso, shifts: day.shifts || {} };
      populateWhiteRequestStations();
      renderWhiteAmbulanceGrid(cache.whiteDay, iso);
      renderWhiteRequests();
    });
  }

  function renderWhiteCalendar() {
    if (!el.whiteGrid || !el.whiteWeekdays || !el.whiteMonthLabel) return;
    var y = state.whiteViewDate.getFullYear();
    var m = state.whiteViewDate.getMonth();
    el.whiteMonthLabel.textContent = HE_MONTHS[m] + " " + y;

    el.whiteWeekdays.innerHTML = "";
    HE_WEEKDAYS_SHORT.forEach(function (w) {
      var s = document.createElement("span");
      s.textContent = w;
      el.whiteWeekdays.appendChild(s);
    });

    el.whiteGrid.innerHTML = "";
    var firstDay = new Date(y, m, 1).getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var today = new Date();
    var isCurMonth = today.getFullYear() === y && today.getMonth() === m;

    for (var b = 0; b < firstDay; b++) {
      var blank = document.createElement("div");
      blank.className = "day-cell is-empty";
      el.whiteGrid.appendChild(blank);
    }

    for (var d = 1; d <= daysInMonth; d++) {
      var iso = y + "-" + pad(m + 1) + "-" + pad(d);
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "day-cell";
      if (isCurMonth && today.getDate() === d) cell.classList.add("is-today");
      if (state.whiteAmbulanceDate === iso) cell.classList.add("is-selected");

      var num = document.createElement("span");
      num.className = "day-num";
      num.textContent = d;
      cell.appendChild(num);

      appendWhiteDayPreview(cell, (cache.whiteMonthByDate && cache.whiteMonthByDate[iso]) || []);
      (function (isoDate) {
        cell.addEventListener("click", function () { selectWhiteDay(isoDate); });
      })(iso);
      el.whiteGrid.appendChild(cell);
    }
  }

  function appendWhiteDayPreview(cell, rows) {
    if (!rows || !rows.length) return;
    var preview = document.createElement("div");
    preview.className = "day-preview";
    var seen = {};
    rows.slice().sort(function (a, b) { return shiftOrder(a.shift) - shiftOrder(b.shift); }).forEach(function (row) {
      var key = String(row.stationName || "") + "|" + String(row.shift || "");
      if (seen[key]) return;
      seen[key] = true;
      var line = document.createElement("div");
      line.className = "day-shift " + row.shift;
      var band = document.createElement("span");
      band.className = "day-shift-band";
      var names = document.createElement("span");
      names.className = "day-shift-names";
      names.textContent = (row.stationName || "תחנה") + " · " + ((row.driver || row.medic) ? [row.driver, row.medic].filter(Boolean).join(" / ") : "ללא צוות");
      line.appendChild(band);
      line.appendChild(names);
      preview.appendChild(line);
    });
    cell.appendChild(preview);
  }

  function selectWhiteDay(iso) {
    state.whiteAmbulanceDate = iso;
    var parts = iso.split("-");
    state.whiteViewDate = new Date(+parts[0], (+parts[1] || 1) - 1, 1);
    if (el.whiteAmbulanceDate) el.whiteAmbulanceDate.value = iso;
    if (el.tabWhiteImport && !el.tabWhiteImport.hidden) loadWhiteImportPanel();
    else loadWhiteAmbulancePanel();
  }

  function renderWhiteAmbulanceGrid(day, iso) {
    if (!el.whiteAmbulanceGrid) return;
    var stations = (cache.whiteStations || []).slice().sort(function (a, b) {
      var byShift = shiftOrder(a.shift) - shiftOrder(b.shift);
      if (byShift) return byShift;
      return String(a.name || "").localeCompare(String(b.name || ""), "he");
    });
    var shifts = (day && day.shifts) || {};
    el.whiteAmbulanceGrid.innerHTML = "";

    if (!stations.length) {
      var empty = document.createElement("p");
      empty.className = "engine-empty";
      empty.textContent = "לא הוגדרו תחנות אמבולנס לבן. יש להוסיף תחנות בלשונית ניהול תחנות ומשמרות.";
      el.whiteAmbulanceGrid.appendChild(empty);
      return;
    }

    var table = document.createElement("table");
    table.className = "users-table stations-table";
    var thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>תחנה</th><th>משמרת</th><th>נהג/ת</th><th>פראמדיק/ית</th><th>מלווה א׳</th><th>מלווה ב׳</th><th>הערה</th></tr>";
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    stations.forEach(function (st) {
      var row = shifts[st.id] || {};
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = st.name;
      tr.appendChild(tdName);

      var tdShift = document.createElement("td");
      tdShift.textContent = shiftLabel(st.shift);
      tr.appendChild(tdShift);

      [
        { key: "driver", label: "נהג/ת" },
        { key: "medic", label: "פראמדיק/ית" },
        { key: "intern1", label: "מלווה א׳" },
        { key: "intern2", label: "מלווה ב׳" },
        { key: "note", label: "הערה" },
      ].forEach(function (slot) {
        var td = document.createElement("td");
        var input = document.createElement("input");
        input.type = "text";
        input.className = "slot-input";
        input.setAttribute("data-white-station", String(st.id));
        input.setAttribute("data-white-slot", slot.key);
        input.setAttribute("aria-label", slot.label + " עבור " + st.name);
        input.value = String(row[slot.key] || "");
        input.disabled = !canEditSchedule();
        if (slot.key !== "note") {
          var listId = "white_dl_" + st.id + "_" + slot.key;
          input.setAttribute("list", listId);
          var dl = document.createElement("datalist");
          dl.id = listId;
          comboNames().forEach(function (name) {
            var opt = document.createElement("option");
            opt.value = name;
            dl.appendChild(opt);
          });
          td.appendChild(input);
          td.appendChild(dl);
        } else {
          td.appendChild(input);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.whiteAmbulanceGrid.appendChild(table);
  }

  function collectWhiteSchedulePayload() {
    var out = { shifts: {}, custom: {} };
    (cache.whiteStations || []).forEach(function (st) {
      var getVal = function (slot) {
        var node = document.querySelector('[data-white-station="' + st.id + '"][data-white-slot="' + slot + '"]');
        return node ? String(node.value || "").trim() : "";
      };
      out.shifts[st.id] = {
        driver: getVal("driver"),
        medic: getVal("medic"),
        intern1: getVal("intern1"),
        intern2: getVal("intern2"),
        note: getVal("note"),
      };
    });
    return out;
  }

  function saveWhiteScheduleBoard() {
    if (!isWhiteAmbulanceAdmin() || !canEditSchedule()) return;
    var iso = normalizeWhiteAmbulanceDate();
    var payload = collectWhiteSchedulePayload();
    api("PUT", "schedules/" + iso + "?context=white-ambulance", payload).then(function () {
      toast("לוח אמבולנס לבן נשמר", true);
      return loadWhiteAmbulancePanel();
    }).catch(function () {
      toast("שמירת לוח אמבולנס לבן נכשלה", false);
    });
  }

  function loadWhiteRequests() {
    if (!isWhiteAmbulanceAdmin()) return Promise.resolve([]);
    return api("GET", "white-requests").then(function (d) {
      cache.whiteRequests = (d && d.requests) || [];
      return cache.whiteRequests;
    }).catch(function () {
      cache.whiteRequests = [];
      return [];
    });
  }

  function populateWhiteRequestStations() {
    if (!el.whiteRequestStation) return;
    el.whiteRequestStation.innerHTML = "";
    (cache.whiteStations || []).forEach(function (st) {
      var opt = document.createElement("option");
      opt.value = String(st.id);
      opt.textContent = st.name + " · " + shiftLabel(st.shift);
      el.whiteRequestStation.appendChild(opt);
    });
  }

  function renderWhiteRequests() {
    if (!el.whiteRequestsTbody) return;
    var rows = cache.whiteRequests || [];
    el.whiteRequestsTbody.innerHTML = "";
    if (!rows.length) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 7;
      td.className = "empty-row";
      td.textContent = "אין בקשות שיבוץ כרגע.";
      tr.appendChild(td);
      el.whiteRequestsTbody.appendChild(tr);
      return;
    }
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var statusLabel = r.status === "approved" ? "אושר" : r.status === "rejected" ? "נדחה" : "ממתין";
      [r.requesterName, shortDate(r.targetDate), r.stationName, slotLabel(r.slot), statusLabel, r.note || "—"].forEach(function (txt) {
        var td = document.createElement("td");
        td.textContent = txt;
        tr.appendChild(td);
      });
      var tdActions = document.createElement("td");
      if (r.status === "pending" && isAdmin()) {
        var ok = document.createElement("button");
        ok.type = "button";
        ok.className = "btn-xs btn-approve";
        ok.textContent = "אישור";
        ok.addEventListener("click", function () { handleWhiteRequestAction(r.id, "approve"); });
        var no = document.createElement("button");
        no.type = "button";
        no.className = "btn-xs btn-block-user";
        no.textContent = "דחייה";
        no.addEventListener("click", function () { handleWhiteRequestAction(r.id, "reject"); });
        tdActions.appendChild(ok);
        tdActions.appendChild(no);
      } else {
        tdActions.textContent = "—";
      }
      tr.appendChild(tdActions);
      el.whiteRequestsTbody.appendChild(tr);
    });
  }

  function slotLabel(slot) {
    if (slot === "driver") return "נהג/ת";
    if (slot === "medic") return "פראמדיק/ית";
    if (slot === "intern1") return "מלווה א׳";
    if (slot === "intern2") return "מלווה ב׳";
    return slot || "—";
  }

  function onSubmitWhiteRequest(e) {
    e.preventDefault();
    if (!isWhiteAmbulanceAdmin()) return;
    var targetDate = (el.whiteRequestDate && el.whiteRequestDate.value) || normalizeWhiteAmbulanceDate();
    var stationId = Number(el.whiteRequestStation && el.whiteRequestStation.value);
    var slot = (el.whiteRequestSlot && el.whiteRequestSlot.value) || "intern1";
    var note = (el.whiteRequestNote && el.whiteRequestNote.value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(targetDate || "")) || !stationId) {
      toast("יש לבחור תאריך, תחנה ותפקיד", false);
      return;
    }
    api("POST", "white-requests", { targetDate: targetDate, stationId: stationId, slot: slot, note: note }).then(function () {
      toast("הבקשה נשלחה לאישור", true);
      if (el.whiteRequestNote) el.whiteRequestNote.value = "";
      return loadWhiteRequests();
    }).then(function () {
      renderWhiteRequests();
    }).catch(function (err) {
      if (err && err.status === 409) toast("המשבצת כבר תפוסה", false);
      else toast("שליחת הבקשה נכשלה", false);
    });
  }

  function handleWhiteRequestAction(id, action) {
    api("PATCH", "white-requests/" + id, { action: action }).then(function () {
      toast(action === "approve" ? "הבקשה אושרה" : "הבקשה נדחתה", true);
      return Promise.all([loadWhiteRequests(), loadWhiteAmbulancePanel()]);
    }).then(function () {
      renderWhiteRequests();
    }).catch(function (err) {
      if (err && err.status === 409) toast("לא ניתן לאשר: המשבצת כבר מאוישת", false);
      else toast("עדכון הבקשה נכשל", false);
    });
  }

  function loadWhiteImportPanel() {
    if (!isWhiteAmbulanceAdmin()) return Promise.resolve();
    var iso = normalizeWhiteAmbulanceDate();
    syncDailyImportDay();
    if (el.whiteImportDate) el.whiteImportDate.value = iso;
    if (el.whiteAmbulanceDate) el.whiteAmbulanceDate.value = iso;
    return loadWhitePrivateMonth().then(function () {
      renderWhiteCalendar();
      cache.privateDaily = (cache.whiteMonthByDate && cache.whiteMonthByDate[iso]) || [];
      renderWhiteImportGrid(cache.privateDaily, iso);
    });
  }

  function renderWhiteImportGrid(rows, iso) {
    if (!el.whiteImportGrid) return;
    rows = (rows || []).slice().sort(function (a, b) {
      var byShift = shiftOrder(a.shift) - shiftOrder(b.shift);
      if (byShift) return byShift;
      return String(a.stationName || "").localeCompare(String(b.stationName || ""), "he");
    });
    el.whiteImportGrid.innerHTML = "";
    if (!rows.length) {
      var empty = document.createElement("p");
      empty.className = "engine-empty";
      empty.textContent = "אין עדיין רשומות ייבוא פרטיות ליום " + iso + ".";
      el.whiteImportGrid.appendChild(empty);
      return;
    }
    var list = document.createElement("div");
    list.className = "private-daily-list";
    rows.forEach(function (row) {
      var card = document.createElement("article");
      card.className = "private-daily-row";
      var head = document.createElement("div");
      head.className = "private-daily-row-head";
      var station = document.createElement("strong");
      station.className = "private-daily-station";
      station.textContent = row.stationName || "תחנה";
      var shift = document.createElement("span");
      shift.className = "private-daily-shift";
      shift.textContent = shiftLabel(row.shift);
      head.appendChild(station);
      head.appendChild(shift);
      card.appendChild(head);
      var meta = document.createElement("div");
      meta.className = "private-daily-meta";
      var d = document.createElement("div");
      d.textContent = "נהג/ת: " + (row.driver || "—");
      var m = document.createElement("div");
      m.textContent = "פראמדיק/ית: " + (row.medic || "—");
      meta.appendChild(d);
      meta.appendChild(m);
      card.appendChild(meta);
      list.appendChild(card);
    });
    el.whiteImportGrid.appendChild(list);
  }

  function loadWhiteStations() {
    if (!isWhiteAmbulanceAdmin()) return Promise.resolve();
    return api("GET", "stations?context=white-ambulance").then(function (list) {
      cache.whiteStations = list || [];
      renderWhiteStations();
      return cache.whiteStations;
    }).catch(function () {
      cache.whiteStations = [];
      renderWhiteStations();
      return [];
    });
  }

  function renderWhiteStations() {
    if (!el.whiteStationsTbody) return;
    var stations = cache.whiteStations || [];
    el.whiteStationsTbody.innerHTML = "";
    if (!stations.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 4;
      emptyCell.className = "empty-row";
      emptyCell.textContent = "לא הוגדרו תחנות לקו האמבולנס הלבן.";
      emptyRow.appendChild(emptyCell);
      el.whiteStationsTbody.appendChild(emptyRow);
      return;
    }
    stations.forEach(function (st) {
      var tr = document.createElement("tr");
      var tdName = document.createElement("td");
      tdName.textContent = st.name;
      var tdShift = document.createElement("td");
      var pill = document.createElement("span");
      pill.className = "shift-pill";
      var dot = document.createElement("span");
      dot.className = "dot " + st.shift;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(shiftLabel(st.shift)));
      tdShift.appendChild(pill);
      var tdHours = document.createElement("td");
      tdHours.className = "u-email";
      tdHours.textContent = st.hours;
      var tdActions = document.createElement("td");
      var trash = document.createElement("button");
      trash.type = "button";
      trash.className = "btn-trash";
      trash.title = "מחיקת תחנה";
      trash.setAttribute("aria-label", "מחיקת התחנה " + st.name);
      trash.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/></svg>';
      (function (id) {
        trash.addEventListener("click", function () { deleteWhiteStation(id); });
      })(st.id);
      tdActions.appendChild(trash);
      tr.appendChild(tdName);
      tr.appendChild(tdShift);
      tr.appendChild(tdHours);
      tr.appendChild(tdActions);
      el.whiteStationsTbody.appendChild(tr);
    });
  }

  function onAddWhiteStation(e) {
    e.preventDefault();
    if (!isWhiteAmbulanceAdmin()) return;
    var name = (el.whiteStationName && el.whiteStationName.value || "").trim();
    var shift = el.whiteStationShift ? el.whiteStationShift.value : "morning";
    var hours = (el.whiteStationHours && el.whiteStationHours.value || "").trim();
    if (!name || !hours) { toast("יש להזין שם תחנה ושעות פעילות", false); return; }
    api("POST", "stations?context=white-ambulance", { name: name, shift: shift, hours: hours, isWhiteAmbulance: true }).then(function () {
      return loadWhiteStations();
    }).then(function () {
      if (el.whiteStationForm) el.whiteStationForm.reset();
      toast("תחנת אמבולנס לבן נשמרה", true);
    }).catch(function () { toast("התחנה לא נשמרה", false); });
  }

  function deleteWhiteStation(id) {
    if (!isWhiteAmbulanceAdmin()) return;
    api("DELETE", "stations/" + id + "?context=white-ambulance").then(function () {
      return loadWhiteStations();
    }).then(function () {
      toast("תחנת אמבולנס לבן נמחקה", true);
    }).catch(function () { toast("המחיקה נכשלה", false); });
  }

  function loadWhiteMonthly() {
    if (!isWhiteAmbulanceAdmin() || !el.whiteMatrixWrap) return Promise.resolve();
    var month = whiteMonthStr();
    return Promise.all([
      loadWhiteStations(),
      api("GET", "schedules?month=" + month + "&matrix=1&context=white-ambulance").catch(function () { return { schedules: {} }; })
    ]).then(function (res) {
      cache.whiteMonthMatrix = (res[1] && res[1].schedules) || {};
      renderWhiteMonthly();
    }).catch(function () {
      cache.whiteMonthMatrix = {};
      renderWhiteMonthly();
    });
  }

  function renderWhiteMonthly() {
    if (!el.whiteMatrixWrap || !el.whiteMatrixMonthLabel) return;
    var y = state.whiteViewDate.getFullYear();
    var m = state.whiteViewDate.getMonth();
    el.whiteMatrixMonthLabel.textContent = HE_MONTHS[m] + " " + y;
    el.whiteMatrixWrap.innerHTML = "";

    var stations = (cache.whiteStations || []).slice();
    stations.sort(function (a, b) {
      var shiftCmp = shiftOrder(a.shift) - shiftOrder(b.shift);
      if (shiftCmp) return shiftCmp;
      return String(a.name || "").localeCompare(String(b.name || ""), "he");
    });

    if (!stations.length) {
      el.whiteMatrixWrap.innerHTML = '<p class="matrix-empty">אין תחנות או נתוני ייבוא לקו האמבולנס הלבן בחודש זה.</p>';
      return;
    }

    var table = document.createElement("table");
    table.className = "engine-log white-monthly-table";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    ["תאריך"].concat(stations.map(function (st) { return st.name + " · " + shiftLabel(st.shift); })).forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = y + "-" + pad(m + 1) + "-" + pad(day);
      var tr = document.createElement("tr");
      var tdDate = document.createElement("td");
      tdDate.textContent = shortDate(iso);
      tr.appendChild(tdDate);
      stations.forEach(function (st) {
        var td = document.createElement("td");
        var day = (cache.whiteMonthMatrix && cache.whiteMonthMatrix[iso]) || {};
        var row = day[String(st.id)] || null;
        td.textContent = row ? ([row.driver, row.medic, row.intern1, row.intern2].filter(Boolean).join(" / ") || "—") : "—";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.whiteMatrixWrap.appendChild(table);
  }

  // Cancel a pending crew auto-reveal re-render (day closed / re-rendered / left).
  function clearRevealTimer() {
    if (state.revealTimer) { window.clearTimeout(state.revealTimer); state.revealTimer = null; }
  }

  // Builds the "משתלמים" panel shown on an event task (training / ceremony / other)
  // in place of the crew grid. It is a flexible, stackable list: the admin adds a
  // row per participant and removes any of them; a viewer sees the saved names
  // read-only. Each editable row is a combobox that mirrors the crew selectors on
  // a plain shift — an explicit, always-openable dropdown of roster names with
  // live search, while still accepting any custom name typed in freely (see
  // openNameMenu). Every input carries data-shift so the board's delegated
  // auto-save picks up edits, and add/remove/select trigger a save too.
  // Collection reads `.trainee-input[data-shift="<id>"]` in order (see collectTrainees).
  function buildTraineeList(iso, admin, shift, trainees) {
    var grid = document.createElement("div");
    grid.className = "trainee-grid";

    var label = document.createElement("div");
    label.className = "trainee-grid-label";
    label.textContent = "משתלמים";
    grid.appendChild(label);

    var list = document.createElement("div");
    list.className = "trainee-list";

    function addRow(value) {
      var row = document.createElement("div");
      row.className = "trainee-row";

      var box = document.createElement("div");
      box.className = "combo trainee-combo";

      var input = document.createElement("input");
      input.type = "text";
      input.className = "combo-input trainee-input";
      input.setAttribute("data-shift", shift.id);
      input.setAttribute("data-trainee", "1");
      input.setAttribute("autocomplete", "off");
      input.placeholder = "בחר/י מהרשימה או הקלד/י שם";
      input.value = value || "";
      if (!admin) input.disabled = true;
      box.appendChild(input);

      if (admin) {
        // Explicit dropdown trigger + the same search-as-you-type / pick-or-type
        // behaviour as the crew selectors. The native <datalist> proved unreliable
        // as a real dropdown, so the list is rendered by openNameMenu.
        var caret = document.createElement("button");
        caret.type = "button";
        caret.className = "combo-caret";
        caret.tabIndex = -1;
        caret.setAttribute("aria-label", "פתיחת רשימת השמות");
        caret.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
          '<path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';
        caret.addEventListener("click", function () { openNameMenu(input, box, iso); });
        box.appendChild(caret);

        input.addEventListener("focus", function () { openNameMenu(input, box, iso); });
        input.addEventListener("input", function () {
          if (state.nameMenu && state.nameMenu.input === input) refreshNameMenu();
          else openNameMenu(input, box, iso);
        });
        input.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNameMenu(); });
      }

      row.appendChild(box);

      if (admin) {
        var rm = document.createElement("button");
        rm.type = "button";
        rm.className = "btn-trainee-del";
        rm.title = "הסרת משתלם/ת";
        rm.setAttribute("aria-label", "הסרת משתלם/ת");
        rm.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
          '<path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>';
        rm.addEventListener("click", function () {
          if (state.nameMenu && state.nameMenu.input === input) closeNameMenu();
          if (row.parentNode) row.parentNode.removeChild(row);
          scheduleAutoSave(iso);
        });
        row.appendChild(rm);
      }

      list.appendChild(row);
      return input;
    }

    if (admin) {
      // Always leave one empty row ready so the admin can just start typing.
      (trainees.length ? trainees : [""]).forEach(addRow);
    } else if (trainees.length) {
      trainees.forEach(addRow);
    } else {
      var empty = document.createElement("div");
      empty.className = "trainee-empty";
      empty.textContent = "לא שובצו משתלמים";
      list.appendChild(empty);
    }

    grid.appendChild(list);

    if (admin) {
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn-trainee-add";
      addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
        '<path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>' +
        '<span>הוסף משתלם/ת</span>';
      addBtn.addEventListener("click", function () {
        var input = addRow("");
        input.focus();
      });
      grid.appendChild(addBtn);
    }

    return grid;
  }

  // ---- Trainee combobox dropdown -------------------------------------------
  // A searchable, always-openable dropdown for a trainee combo input. It offers
  // the same roster the crew selectors use (comboNames) with live substring
  // filtering, while leaving the field free-typeable for a custom name. Only one
  // menu is open at a time; it is body-anchored because the shift card clips
  // overflow, and its lifecycle is torn down on navigation/re-render.
  function closeNameMenu() {
    var m = state.nameMenu;
    if (!m) return;
    document.removeEventListener("click", m.onDoc, true);
    window.removeEventListener("scroll", m.onScroll, true);
    window.removeEventListener("resize", m.onScroll, true);
    if (m.pop && m.pop.parentNode) m.pop.parentNode.removeChild(m.pop);
    state.nameMenu = null;
  }

  function positionNameMenu() {
    var m = state.nameMenu;
    if (!m) return;
    var r = m.input.getBoundingClientRect();
    var w = Math.max(r.width, 200);
    m.pop.style.width = w + "px";
    var left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    if (left < 8) left = 8;
    m.pop.style.left = left + "px";
    m.pop.style.top = (r.bottom + 4) + "px";
  }

  // (Re)build the option list from the current query, honouring live typing.
  function refreshNameMenu() {
    var m = state.nameMenu;
    if (!m) return;
    var q = (m.input.value || "").trim().toLowerCase();
    var matches = comboNames().filter(function (n) {
      return !q || n.toLowerCase().indexOf(q) !== -1;
    });
    m.pop.innerHTML = "";
    if (!matches.length) {
      var none = document.createElement("div");
      none.className = "name-menu-empty";
      none.textContent = q ? "אין התאמה — יישמר השם שהוקלד" : "אין שמות ברשימה";
      m.pop.appendChild(none);
    } else {
      matches.forEach(function (name) {
        var opt = document.createElement("button");
        opt.type = "button";
        opt.className = "name-menu-opt";
        opt.textContent = name; // roster data → textContent (injection-safe)
        if (m.input.value.trim() === name) opt.classList.add("is-current");
        opt.addEventListener("click", function () {
          m.input.value = name;
          closeNameMenu();
          scheduleAutoSave(m.iso);
        });
        m.pop.appendChild(opt);
      });
    }
    positionNameMenu();
  }

  function openNameMenu(input, anchor, iso) {
    if (input.disabled) return;
    var wasOpen = state.nameMenu && state.nameMenu.input === input;
    closeNameMenu();
    if (wasOpen) return; // a second click on the caret toggles it closed

    var pop = document.createElement("div");
    pop.className = "name-menu";
    document.body.appendChild(pop);

    var onDoc = function (e) {
      // Clicks on the field itself (input or caret) are handled by their own
      // listeners; anything else outside the menu closes it.
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      closeNameMenu();
    };
    var onScroll = function () { positionNameMenu(); };
    document.addEventListener("click", onDoc, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    state.nameMenu = { input: input, anchor: anchor, pop: pop, iso: iso, onDoc: onDoc, onScroll: onScroll };

    refreshNameMenu();
  }

  // Read one card's trainee list (event task types) out of the DOM, in order,
  // trimmed and blank-stripped. domId is the station id or "c<id>" for a custom.
  function collectTrainees(domId) {
    var out = [];
    var nodes = document.querySelectorAll('.trainee-input[data-shift="' + domId + '"]');
    Array.prototype.forEach.call(nodes, function (n) {
      var v = (n.value || "").trim();
      if (v) out.push(v);
    });
    return out;
  }

  // Builds the WhatsApp-ready roster text for ONE shift type on a day — never a
  // consolidated multi-shift message. Each call captures only the given shift's
  // context: a single block headed by "*<weekday> <shift> <DD.M>*", then a
  // "*אטנים*" section listing that shift's stations. Each line reports ONLY the
  // two helpers (מלווה א׳ / מלווה ב׳) — drivers and paramedics are intentionally
  // excluded. A station with no helpers assigned reads "ללא מלווים".
  function buildWhatsappText(shiftType, rows, dateObj) {
    var weekday = HE_WEEKDAYS[dateObj.getDay()];
    var dateLabel = dateObj.getDate() + "." + (dateObj.getMonth() + 1);

    // Only this shift type's stations, in the order the rows already arrive.
    var stationLines = rows
      .filter(function (row) { return row.shift === shiftType; })
      .map(function (row) {
        var saved = row.saved || {};
        var helpers = [];
        // Event tasks carry participants in the trainee list, not the crew slots.
        if (saved.taskType && saved.taskType !== "shift") {
          (Array.isArray(saved.trainees) ? saved.trainees : []).forEach(function (n) {
            if (n && n.trim()) helpers.push(n.trim());
          });
          var whoEvent = helpers.length ? helpers.join(" ו") : "ללא משתלמים";
          return row.name + "- " + whoEvent;
        }
        if (saved.intern1 && saved.intern1.trim()) helpers.push(saved.intern1.trim());
        if (saved.intern2 && saved.intern2.trim()) helpers.push(saved.intern2.trim());
        var who = helpers.length ? helpers.join(" ו") : "ללא מלווים";
        return row.name + "- " + who;
      });

    var lines = ["*" + weekday + " " + shiftLabel(shiftType) + " " + dateLabel + "*", "", "*אטנים*"];
    return lines.concat(stationLines).join("\n");
  }

  // Copies a single shift's WhatsApp text to the clipboard, with a graceful
  // fallback for browsers without the async Clipboard API. Surfaces
  // success/failure via toast.
  function copyWhatsapp(shiftType, rows, dateObj, btn) {
    var text = buildWhatsappText(shiftType, rows, dateObj);
    function done() { toast("סידור ה" + shiftLabel(shiftType) + " הועתק ללוח — אפשר להדביק בוואטסאפ", true); }
    function fail() { toast("ההעתקה נכשלה, נסו שוב", false); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (legacyCopy(text)) done(); else fail();
      });
    } else {
      if (legacyCopy(text)) done(); else fail();
    }
  }

  // Clipboard fallback via a transient off-screen textarea + execCommand.
  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  // The "add task to this day" form. A station/task name (free text with
  // quick-select suggestions), the shift band, and the "סוג המשימה" task type —
  // plus a save button that creates the task for this date only. An event task
  // type opens with the trainee list instead of the standard crew grid.
  function buildAddCustomShift(iso) {
    var card = document.createElement("section");
    card.className = "add-shift-card";

    var head = document.createElement("div");
    head.className = "add-shift-head";
    var h4 = document.createElement("h4");
    h4.textContent = "הוסף משימה ליום זה";
    var sub = document.createElement("span");
    sub.className = "add-shift-sub";
    sub.textContent = "משימה נקודתית שתתווסף ללוח של תאריך זה בלבד";
    head.appendChild(h4);
    head.appendChild(sub);
    card.appendChild(head);

    var form = document.createElement("form");
    form.className = "add-shift-form";
    form.setAttribute("autocomplete", "off");

    // Station / task name: free text, with a datalist of existing station names
    // for a quick pick. Free-typed names are accepted just the same.
    var nameWrap = document.createElement("div");
    nameWrap.className = "add-shift-field";
    var nameLabel = document.createElement("label");
    var nameId = "custom-shift-name";
    nameLabel.setAttribute("for", nameId);
    nameLabel.textContent = "שם המשימה";
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.id = nameId;
    nameInput.className = "add-shift-name";
    nameInput.setAttribute("list", "custom-shift-name-list");
    nameInput.placeholder = "בחר/י או הקלד/י שם";
    var dl = document.createElement("datalist");
    dl.id = "custom-shift-name-list";
    var seenName = {};
    (cache.stations || []).forEach(function (s) {
      if (s.name && !seenName[s.name]) { seenName[s.name] = true; var o = document.createElement("option"); o.value = s.name; dl.appendChild(o); }
    });
    nameWrap.appendChild(nameLabel);
    nameWrap.appendChild(nameInput);
    nameWrap.appendChild(dl);

    // Shift type: night / morning / evening, listed in chronological order.
    var shiftWrap = document.createElement("div");
    shiftWrap.className = "add-shift-field";
    var shiftLabelEl = document.createElement("label");
    var shiftId = "custom-shift-type";
    shiftLabelEl.setAttribute("for", shiftId);
    shiftLabelEl.textContent = "משמרת";
    var shiftSelect = document.createElement("select");
    shiftSelect.id = shiftId;
    shiftSelect.className = "add-shift-type";
    SHIFT_TYPES.forEach(function (st) {
      var o = document.createElement("option");
      o.value = st.id;
      o.textContent = st.label;
      shiftSelect.appendChild(o);
    });
    shiftWrap.appendChild(shiftLabelEl);
    shiftWrap.appendChild(shiftSelect);

    // Task type: משמרת (default) / event types. Chosen up front so the created
    // card opens with the matching layout (crew grid vs. trainee list).
    var typeWrap = document.createElement("div");
    typeWrap.className = "add-shift-field";
    var typeLabelEl = document.createElement("label");
    var typeId = "custom-shift-tasktype";
    typeLabelEl.setAttribute("for", typeId);
    typeLabelEl.textContent = "סוג המשימה";
    var typeSelect = document.createElement("select");
    typeSelect.id = typeId;
    typeSelect.className = "add-shift-tasktype";
    TASK_TYPES.forEach(function (t) {
      var o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.label;
      typeSelect.appendChild(o);
    });
    typeWrap.appendChild(typeLabelEl);
    typeWrap.appendChild(typeSelect);

    // Start / end time: manually editable for every task type. Combined into the
    // task's hours string ("HH:MM – HH:MM"), which drives the "הוסף ליומן גוגל"
    // export so the calendar event's start/end match exactly what was entered.
    var startWrap = document.createElement("div");
    startWrap.className = "add-shift-field";
    var startLabel = document.createElement("label");
    var startId = "custom-shift-start";
    startLabel.setAttribute("for", startId);
    startLabel.textContent = "שעת התחלה";
    var startInput = document.createElement("input");
    startInput.type = "time";
    startInput.id = startId;
    startInput.className = "add-shift-time";
    startWrap.appendChild(startLabel);
    startWrap.appendChild(startInput);

    var endWrap = document.createElement("div");
    endWrap.className = "add-shift-field";
    var endLabel = document.createElement("label");
    var endId = "custom-shift-end";
    endLabel.setAttribute("for", endId);
    endLabel.textContent = "שעת סיום";
    var endInput = document.createElement("input");
    endInput.type = "time";
    endInput.id = endId;
    endInput.className = "add-shift-time";
    endWrap.appendChild(endLabel);
    endWrap.appendChild(endInput);

    // Prefill the times from the selected shift band's defaults as a convenience,
    // and refresh them whenever the band changes — while leaving them fully
    // editable so an admin can set any custom window.
    function applyShiftDefaults() {
      var def = SHIFT_DEFAULT_RANGE[shiftSelect.value];
      if (def) { startInput.value = def[0]; endInput.value = def[1]; }
    }
    applyShiftDefaults();
    shiftSelect.addEventListener("change", applyShiftDefaults);

    var foot = document.createElement("div");
    foot.className = "add-shift-foot";
    var saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "שמור משימה";
    foot.appendChild(saveBtn);

    form.appendChild(nameWrap);
    form.appendChild(shiftWrap);
    form.appendChild(typeWrap);
    form.appendChild(startWrap);
    form.appendChild(endWrap);
    form.appendChild(foot);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      addCustomShift(iso, nameInput.value, shiftSelect.value, typeSelect.value, startInput.value, endInput.value);
    });

    card.appendChild(form);
    return card;
  }

  // Combine two "HH:MM" values into the app's hours string ("06:00 – 14:00").
  // Falls back gracefully when only one (or neither) is supplied.
  function buildHoursString(start, end) {
    var s = (start || "").trim();
    var e = (end || "").trim();
    if (s && e) return s + " – " + e;
    return s || e || "";
  }

  // Admin: create a one-off custom task for this date, then re-render the day so
  // it appears (empty slots / trainee list ready) in the correct chronological
  // position.
  function addCustomShift(iso, name, shift, taskType, start, end) {
    if (!isAdmin()) return;
    var clean = (name || "").trim();
    if (!clean) { toast("יש להזין שם משימה", false); return; }
    var shiftType = (shift === "morning" || shift === "evening" || shift === "night") ? shift : "morning";
    var type = knownTaskType(taskType);
    var hours = buildHoursString(start, end);

    api("POST", "schedules/" + iso + "/custom", { name: clean, shift: shiftType, taskType: type, hours: hours }).then(function (row) {
      if (cache.day && cache.day.iso === iso) {
        cache.day.custom = (cache.day.custom || []).concat([row]);
      }
      renderDayDetail(iso);
      toast("המשימה נוספה ליום זה", true);
      loadMonth(); // a new staffable shift can change the calendar markers
    }).catch(function () { toast("הוספת המשימה נכשלה", false); });
  }

  // Admin: delete a per-day custom shift (and any assignments inside it). Warns
  // first when it already holds people, mirroring the station-removal flow.
  function deleteCustomShift(iso, shift) {
    if (!isAdmin()) return;
    var hasPeople = false;
    SLOTS.forEach(function (s) {
      var f = byId("f_" + shift.id + "_" + s.key);
      if (f && f.value.trim()) hasPeople = true;
    });
    if (collectTrainees(shift.id).length) hasPeople = true;
    var msg = hasPeople
      ? "משמרת זו כבר מכילה שיבוצים. האם אתה בטוח שברצונך למחוק אותה ואת כל השיבוצים בתוכה?"
      : "האם להסיר את המשמרת “" + shift.name + " - " + shiftLabel(shift.shift) + "” מיום זה?";
    if (!window.confirm(msg)) return;

    api("DELETE", "schedules/" + iso + "/custom/" + shift.dbId).then(function () {
      if (cache.day && cache.day.iso === iso) {
        cache.day.custom = (cache.day.custom || []).filter(function (c) { return c.id !== shift.dbId; });
      }
      renderDayDetail(iso);
      toast("המשמרת הוסרה מיום זה", true);
      refreshShiftCounts(); // an assignment may have been dropped with it
      loadMonth();          // refresh the calendar's assignment markers
    }).catch(function () { toast("הסרת המשמרת נכשלה", false); });
  }

  // Does this station carry a person in any slot — either already saved for the
  // day or just typed into the live inputs? Drives the stronger delete warning.
  function stationHasAssignments(iso, station) {
    var saved = (cache.day && cache.day.iso === iso && cache.day.shifts && cache.day.shifts[station.id]) || null;
    if (saved && (saved.driver || saved.medic || saved.intern1 || saved.intern2)) return true;
    if (saved && Array.isArray(saved.trainees) && saved.trainees.length) return true;
    var hit = false;
    SLOTS.forEach(function (s) {
      var f = byId("f_" + station.id + "_" + s.key);
      if (f && f.value.trim()) hit = true;
    });
    if (collectTrainees(station.id).length) hit = true;
    return hit;
  }

  // Admin: drop one station/shift from this day only. Warns before discarding a
  // slot that already holds assignments, then persists the per-day removal.
  function hideShift(iso, station) {
    if (!isAdmin()) return;
    var msg = stationHasAssignments(iso, station)
      ? "משמרת זו כבר מכילה שיבוצים. האם אתה בטוח שברצונך למחוק אותה ואת כל השיבוצים בתוכה?"
      : "האם להסיר את המשמרת “" + station.name + " - " + shiftLabel(station.shift) + "” מיום זה?";
    if (!window.confirm(msg)) return;

    api("PUT", "schedules/" + iso + "/hidden/" + station.id).then(function () {
      if (cache.day && cache.day.iso === iso) {
        cache.day.hidden = (cache.day.hidden || []).concat([station.id]);
        if (cache.day.shifts) delete cache.day.shifts[station.id];
      }
      renderDayDetail(iso);
      toast("המשמרת הוסרה מיום זה", true);
      refreshShiftCounts(); // an assignment may have been dropped with it
      loadMonth();          // refresh the calendar's "משובץ" markers
    }).catch(function () { toast("הסרת המשמרת נכשלה", false); });
  }

  // Admin: bring a previously removed station/shift back for this day.
  function restoreShift(iso, station) {
    if (!isAdmin()) return;
    api("DELETE", "schedules/" + iso + "/hidden/" + station.id).then(function () {
      if (cache.day && cache.day.iso === iso) {
        cache.day.hidden = (cache.day.hidden || []).filter(function (sid) { return sid !== station.id; });
      }
      renderDayDetail(iso);
      toast("המשמרת שוחזרה ליום זה", true);
    }).catch(function () { toast("שחזור המשמרת נכשל", false); });
  }

  // Read the entire open day board out of the DOM into the API payload shape:
  // { shifts: { stationId: {...} }, custom: { customId: {...} } }. Shared by every
  // save path so the manual collection logic lives in exactly one place.
  function collectDayPayload(iso) {
    var hidden = {};
    ((cache.day && cache.day.iso === iso && cache.day.hidden) || []).forEach(function (sid) { hidden[sid] = true; });
    var shifts = {};
    (cache.stations || []).forEach(function (shift) {
      if (hidden[shift.id]) return; // removed from this day — never re-save it
      var entry = {};
      SLOTS.forEach(function (slot) {
        var f = byId("f_" + shift.id + "_" + slot.key);
        entry[slot.key] = f ? f.value.trim() : "";
      });
      var noteField = byId("f_" + shift.id + "_note");
      entry.note = noteField ? noteField.value.trim() : "";
      var nf1 = byId("f_" + shift.id + "_intern1_noform");
      var nf2 = byId("f_" + shift.id + "_intern2_noform");
      entry.noFormIntern1 = nf1 ? !!nf1.checked : false;
      entry.noFormIntern2 = nf2 ? !!nf2.checked : false;
      var typeSel = byId("f_" + shift.id + "_tasktype");
      entry.taskType = typeSel ? knownTaskType(typeSel.value) : "shift";
      entry.trainees = collectTrainees(shift.id);
      // Mutual exclusivity, mirrored on the server: a shift keeps its crew and no
      // trainees; an event drops the crew columns and keeps only the trainees.
      if (entry.taskType !== "shift") {
        SLOTS.forEach(function (slot) { entry[slot.key] = ""; });
        entry.noFormIntern1 = false; entry.noFormIntern2 = false;
      } else {
        entry.trainees = [];
      }
      shifts[shift.id] = entry;
    });

    // Per-day custom shifts save into their own store, keyed by id. Field ids are
    // prefixed "c" (e.g. f_c3_driver) so they never collide with station ids.
    var custom = {};
    ((cache.day && cache.day.iso === iso && cache.day.custom) || []).forEach(function (c) {
      var domId = "c" + c.id;
      var entry = {};
      SLOTS.forEach(function (slot) {
        var f = byId("f_" + domId + "_" + slot.key);
        entry[slot.key] = f ? f.value.trim() : "";
      });
      var noteField = byId("f_" + domId + "_note");
      entry.note = noteField ? noteField.value.trim() : "";
      var typeSel = byId("f_" + domId + "_tasktype");
      entry.taskType = typeSel ? knownTaskType(typeSel.value) : "shift";
      entry.trainees = collectTrainees(domId);
      if (entry.taskType !== "shift") {
        SLOTS.forEach(function (slot) { entry[slot.key] = ""; });
      } else {
        entry.trainees = [];
      }
      custom[c.id] = entry;
    });

    return { shifts: shifts, custom: custom };
  }

  // Render the inline auto-save pill in one of its states. A no-op when the open
  // day is read-only (no pill exists), so callers never have to guard.
  function setAutoSaveStatus(phase) {
    var node = autosaveEl;
    if (!node) return;
    if (autosaveHideTimer) { clearTimeout(autosaveHideTimer); autosaveHideTimer = null; }
    node.hidden = false;
    if (phase === "saving") {
      node.className = "autosave-status is-saving";
      node.innerHTML = '<span class="autosave-spinner" aria-hidden="true"></span><span>שומר…</span>';
    } else if (phase === "saved") {
      node.className = "autosave-status is-saved";
      node.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
        '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4 4 10-10"/></svg>' +
        '<span>נשמר אוטומטית</span>';
      // Ease the confirmation back to idle so it stays subtle.
      autosaveHideTimer = setTimeout(function () {
        autosaveHideTimer = null;
        if (autosaveEl === node) { node.className = "autosave-status is-idle"; node.hidden = true; }
      }, 2200);
    } else if (phase === "error") {
      node.className = "autosave-status is-error";
      node.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
        '<path fill="currentColor" d="M12 2 1 21h22L12 2zm0 6 7 12H5l7-12zm-1 4h2v4h-2v-4zm0 5h2v2h-2v-2z"/></svg>' +
        '<span>השמירה נכשלה — נסו שוב</span>';
    }
  }

  // Persist on every committed field change. A `change` event only fires once the
  // admin actually commits an edit (leaving a combo/note, or toggling a checkbox),
  // so this saves exactly the touched days and never on mere navigation. Saving
  // synchronously on the event — rather than on a timer — also sidesteps a cross-day
  // race: station field IDs are shared between days, so a deferred save could read
  // the wrong day's DOM. The blur that precedes any navigation flushes the edit first.
  function scheduleAutoSave(iso) {
    if (!canEditSchedule()) return;
    autoSaveDay(iso);
  }

  // Persist the whole open day, reusing the existing schedules upsert endpoint.
  // Mirrors the cache the way quickAssign does so the local copy stays in step
  // without a disruptive re-render of the board the admin is still editing.
  function autoSaveDay(iso) {
    if (!canEditSchedule()) return;          // viewers cannot save
    if (state.selectedDate !== iso) return;  // defensive: the open day changed
    // Snapshot the day's shift map BEFORE this save so the global undo can
    // restore it. cache.day.shifts still holds the last-saved state here.
    var prevShifts = (cache.day && cache.day.iso === iso)
      ? JSON.parse(JSON.stringify(cache.day.shifts || {})) : {};
    var payload = collectDayPayload(iso);
    var changed = JSON.stringify(prevShifts) !== JSON.stringify(payload.shifts);
    setAutoSaveStatus("saving");
    api("PUT", "schedules/" + iso, payload).then(function () {
      if (cache.day && cache.day.iso === iso) {
        cache.day.shifts = payload.shifts;
        (cache.day.custom || []).forEach(function (c) {
          var entry = payload.custom[c.id];
          if (!entry) return;
          c.driver = entry.driver; c.medic = entry.medic;
          c.intern1 = entry.intern1; c.intern2 = entry.intern2; c.note = entry.note;
          c.taskType = entry.taskType; c.trainees = entry.trainees;
        });
      }
      // Record the reversible change once the save lands (skip pure no-ops).
      if (changed) {
        var parts = iso.split("-");
        pushUndo({
          source: "day", iso: iso, revertShifts: prevShifts,
          desc: "שינוי שיבוץ · " + parts[2] + "/" + parts[1] + "/" + parts[0]
        });
      }
      setAutoSaveStatus("saved");
      refreshShiftCounts();  // keep the admin's per-trainee counter in sync
      return loadMonth();    // refresh the calendar's "משובץ" indicator
    }).catch(function () {
      setAutoSaveStatus("error");
      toast("שמירת השיבוץ נכשלה", false);
    });
  }

  /* ---------------- Availability submission (trainees) ---------------- */
  // Whether the logged-in trainee carries the "ללא שישי+שבת" restriction. When set,
  // every Friday/Saturday slot in the request form is auto-locked to "לא זמין"
  // (cannot) — they can neither request nor be scheduled on those days.
  function weekendRestricted() {
    return !!(state.user && state.user.restrictWeekendShifts);
  }
  // True for a Friday or Saturday ISO date ('YYYY-MM-DD'), parsed as a local date so
  // it matches the weekday the calendar shows.
  function isWeekendIso(iso) {
    var p = (iso || "").split("-");
    if (p.length !== 3) return false;
    var dow = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay();
    return dow === 5 || dow === 6; // 5 = Friday, 6 = Saturday
  }

  // The viewer's own preferences for the open day, as { shiftType: status }.
  function myAvailMap(iso) {
    var map = {};
    var email = (state.user && state.user.email || "").toLowerCase();
    var entries = (cache.day && cache.day.iso === iso) ? cache.day.availEntries : [];
    (entries || []).forEach(function (e) {
      if ((e.email || "").toLowerCase() === email) map[e.shiftType] = e.preference;
    });
    return map;
  }

  function buildAvailForm(iso, locked) {
    var mine = myAvailMap(iso);

    var card = document.createElement("section");
    card.className = "avail-card";

    var head = document.createElement("div");
    head.className = "avail-card-head";
    var h4 = document.createElement("h4");
    h4.textContent = "הגשת אילוצים ובקשות";
    head.appendChild(h4);

    if (locked) {
      var lockTag = document.createElement("span");
      lockTag.className = "lock-pill";
      lockTag.textContent = "נעול";
      head.appendChild(lockTag);
    }
    card.appendChild(head);

    if (locked) {
      var banner = document.createElement("p");
      banner.className = "lock-banner";
      banner.textContent = "הגשת האילוצים לשבוע זה ננעלה";
      card.appendChild(banner);
    }

    var rows = document.createElement("div");
    rows.className = "avail-rows";

    // A weekend-restricted trainee ("ללא שישי+שבת") gets every shift on a Friday or
    // Saturday force-locked to "לא זמין": the cannot option is pre-selected and all
    // buttons disabled. The server rejects any other weekend preference regardless.
    var weekendBlocked = weekendRestricted() && isWeekendIso(iso);

    SHIFT_TYPES.forEach(function (st) {
      var current = mine[st.id] || "";
      // A night-restricted trainee ("לא זמין למשמרות לילה") can't request nights:
      // render the night row disabled with an explanatory note. The server rejects
      // any night preference from them regardless, so this is purely UX.
      var nightBlocked = st.id === "night" && state.user && state.user.restrictNightShifts;
      // Weekend lock takes precedence and forces the "cannot" selection.
      if (weekendBlocked) current = "cannot";
      var blocked = nightBlocked || weekendBlocked;

      var row = document.createElement("div");
      row.className = "avail-row" + (blocked ? " is-blocked" : "");
      row.setAttribute("data-avail-shift", st.id);

      var name = document.createElement("span");
      name.className = "avail-shift-name";
      name.innerHTML = '<span class="shift-band ' + st.id + '"></span>משמרת ' + st.label;
      if (blocked) {
        var note = document.createElement("span");
        note.className = "avail-blocked-note";
        note.textContent = weekendBlocked ? "לא זמין (ללא שישי+שבת)" : "לא זמין למשמרות לילה";
        name.appendChild(note);
      }
      row.appendChild(name);

      var opts = document.createElement("div");
      opts.className = "avail-options";
      AVAIL_OPTIONS.forEach(function (opt) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "avail-opt " + opt.cls + (current === opt.key ? " is-active" : "");
        b.textContent = opt.label;
        b.setAttribute("data-status", opt.key);
        if (locked || blocked) {
          b.disabled = true;
        } else {
          b.addEventListener("click", function () {
            Array.prototype.forEach.call(opts.querySelectorAll(".avail-opt"), function (other) {
              other.classList.remove("is-active");
            });
            b.classList.add("is-active");
          });
        }
        opts.appendChild(b);
      });
      row.appendChild(opts);
      rows.appendChild(row);
    });
    card.appendChild(rows);

    if (!locked) {
      var foot = document.createElement("div");
      foot.className = "avail-foot";
      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-primary";
      saveBtn.textContent = "שמירת אילוצים";
      saveBtn.addEventListener("click", function () { saveAvailability(iso); });
      foot.appendChild(saveBtn);
      card.appendChild(foot);
    }

    return card;
  }

  function saveAvailability(iso) {
    if (isAdmin()) return;             // admins place directly, they don't submit
    if (isAvailLocked(iso)) { toast("הגשת האילוצים לשבוע זה ננעלה", false); return; }

    var prefs = {};
    var blockNight = state.user && state.user.restrictNightShifts;
    // Weekend-restricted trainees submit an explicit "לא זמין" (cannot) for every
    // shift on a Friday/Saturday, mirroring the locked UI selection.
    var weekendBlocked = weekendRestricted() && isWeekendIso(iso);
    SHIFT_TYPES.forEach(function (st) {
      if (weekendBlocked) { prefs[st.id] = "cannot"; return; }
      if (blockNight && st.id === "night") return; // restricted trainees never submit nights
      var group = el.dayDetail.querySelector('[data-avail-shift="' + st.id + '"]');
      if (!group) return;
      var active = group.querySelector(".avail-opt.is-active");
      if (active) prefs[st.id] = active.getAttribute("data-status");
    });

    api("PUT", "availability/" + iso, { prefs: prefs }).then(function () {
      return loadDay(iso);
    }).then(function () {
      toast("האילוצים נשמרו בהצלחה", true);
    }).catch(function (err) {
      if (err && err.status === 423) toast("הגשת האילוצים לשבוע זה ננעלה", false);
      else toast("האילוצים לא נשמרו", false);
    });
  }

  /* ---------------- Weekly availability grid (trainees) ---------------- */
  // Columns follow strict chronological order: Night → Morning → Evening.
  var WEEKLY_SHIFT_ORDER = ["night", "morning", "evening"];

  // Local ISO 'YYYY-MM-DD' for a Date.
  function isoOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  // Sunday 00:00 of the upcoming week — the week trainees submit requests for.
  function upcomingWeekStart() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // back to this week's Sunday
    d.setDate(d.getDate() + 7);          // forward to next week's Sunday
    return d;
  }

  // Pull the trainee's own preferences for the selected target week, then render.
  // The submission week defaults to the upcoming week but can be changed with the
  // "בחר שבוע להגשת בקשות" picker (see buildWeeklyWeekPicker).
  function loadWeekly() {
    if (!el.weeklyView) return Promise.resolve();
    var start = state.weeklyWeek || upcomingWeekStart();
    state.weeklyWeek = start;
    var startIso = isoOf(start);
    el.weeklyView.innerHTML = '<p class="weekly-loading">טוען…</p>';
    return api("GET", "availability?week=" + startIso).then(function (d) {
      var byDate = {};
      (d.entries || []).forEach(function (e) {
        (byDate[e.date] || (byDate[e.date] = {}))[e.shiftType] = e.preference;
      });
      cache.week = { start: startIso, byDate: byDate };
      renderWeekly(start, byDate);
    }).catch(function () {
      cache.week = { start: startIso, byDate: {} };
      renderWeekly(start, {});
    });
  }

  // Dropdown for choosing which upcoming week the trainee submits requests for.
  // Options run from the upcoming week forward, each labelled by its Sunday–
  // Saturday range. Changing it re-loads the grid for the newly chosen week.
  function buildWeeklyWeekPicker(selectedStart) {
    var wrap = document.createElement("div");
    wrap.className = "weekly-week-pick";
    var label = document.createElement("label");
    label.className = "field";
    var span = document.createElement("span");
    span.textContent = "בחר שבוע להגשת בקשות";
    label.appendChild(span);

    var sel = document.createElement("select");
    sel.id = "weekly-week-select";
    var base = upcomingWeekStart();
    var selIso = isoOf(selectedStart);
    var hasSelected = false;
    for (var i = 0; i < 8; i++) {
      var ws = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i * 7);
      var iso = isoOf(ws);
      var opt = buildWeekOption(ws, iso); // "שבוע DD/MM – DD/MM"
      if (iso === selIso) { opt.selected = true; hasSelected = true; }
      sel.appendChild(opt);
    }
    // Keep a non-default selection (e.g. an older week) visible at the top.
    if (!hasSelected) {
      var cur = buildWeekOption(selectedStart, selIso);
      cur.selected = true;
      sel.insertBefore(cur, sel.firstChild);
    }
    sel.addEventListener("change", function () {
      if (!sel.value) return;
      state.weeklyWeek = weekStartOf(sel.value);
      loadWeekly();
    });
    label.appendChild(sel);
    wrap.appendChild(label);
    return wrap;
  }

  function renderWeekly(start, byDate) {
    var host = el.weeklyView;
    if (!host) return;
    host.innerHTML = "";
    host.appendChild(buildWeeklyWeekPicker(start));

    var startIso = isoOf(start);
    var locked = isAvailLocked(startIso); // the whole week shares one deadline

    var card = document.createElement("section");
    card.className = "avail-card weekly-card";

    var head = document.createElement("div");
    head.className = "avail-card-head";
    var end = new Date(start.getTime()); end.setDate(end.getDate() + 6);
    var h4 = document.createElement("h4");
    h4.textContent = "שבוע " + start.getDate() + "/" + (start.getMonth() + 1) +
      " – " + end.getDate() + "/" + (end.getMonth() + 1);
    head.appendChild(h4);
    var deadline = getWeekDeadline(startIso);
    var hint = document.createElement("span");
    hint.className = "avail-hint";
    hint.textContent = deadline ? ("מועד נעילה: " + formatDeadline(deadline)) : "נעילת הגשות אינה פעילה";
    head.appendChild(hint);
    if (locked) {
      var pill = document.createElement("span");
      pill.className = "lock-pill";
      pill.textContent = "נעול";
      head.appendChild(pill);
    }
    card.appendChild(head);

    if (locked) {
      var banner = document.createElement("p");
      banner.className = "lock-banner";
      banner.textContent = "הגשת האילוצים לשבוע זה ננעלה";
      card.appendChild(banner);
    }

    var legend = document.createElement("div");
    legend.className = "weekly-legend";
    AVAIL_OPTIONS.forEach(function (opt) {
      var item = document.createElement("span");
      item.className = "weekly-legend-item " + opt.cls;
      item.innerHTML = '<span class="weekly-legend-dot"></span>' + opt.label;
      legend.appendChild(item);
    });
    card.appendChild(legend);

    var wrap = document.createElement("div");
    wrap.className = "weekly-grid-wrap";
    var table = document.createElement("table");
    table.className = "weekly-grid";

    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    var corner = document.createElement("th");
    corner.className = "weekly-corner";
    corner.textContent = "יום / משמרת";
    htr.appendChild(corner);
    WEEKLY_SHIFT_ORDER.forEach(function (sid) {
      var th = document.createElement("th");
      th.innerHTML = '<span class="shift-band ' + sid + '"></span>' + shiftLabel(sid);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    for (var i = 0; i < 7; i++) {
      var dayDate = new Date(start.getTime());
      dayDate.setDate(dayDate.getDate() + i);
      var iso = isoOf(dayDate);
      var dm = (byDate && byDate[iso]) || {};

      var tr = document.createElement("tr");
      tr.setAttribute("data-weekly-date", iso);
      // Whole Friday/Saturday rows are locked to "לא זמין" for a weekend-restricted
      // trainee ("ללא שישי+שבת").
      var weekDow = dayDate.getDay();
      var weekendBlockedDay = weekendRestricted() && (weekDow === 5 || weekDow === 6);

      var dayTd = document.createElement("td");
      dayTd.className = "weekly-day";
      dayTd.innerHTML = '<span class="weekly-day-name">' + HE_WEEKDAYS[dayDate.getDay()] + "</span>" +
        '<span class="weekly-day-date">' + dayDate.getDate() + "/" + (dayDate.getMonth() + 1) + "</span>";
      tr.appendChild(dayTd);

      WEEKLY_SHIFT_ORDER.forEach(function (sid) {
        var td = document.createElement("td");
        td.className = "weekly-cell";
        // Night-restricted trainees ("לא זמין למשמרות לילה") can't request nights.
        var nightBlocked = sid === "night" && state.user && state.user.restrictNightShifts;
        // Weekend lock (all shifts on Fri/Sat) takes precedence over the night rule.
        var blocked = nightBlocked || weekendBlockedDay;
        if (blocked) td.className += " is-blocked";
        var group = document.createElement("div");
        group.className = "weekly-opts";
        group.setAttribute("data-weekly-shift", sid);
        var current = weekendBlockedDay ? "cannot" : (dm[sid] || "");
        AVAIL_OPTIONS.forEach(function (opt) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "avail-opt " + opt.cls + (current === opt.key ? " is-active" : "");
          b.textContent = opt.short;
          b.title = weekendBlockedDay ? "לא זמין (ללא שישי+שבת)" : (nightBlocked ? "לא זמין למשמרות לילה" : opt.label);
          b.setAttribute("aria-label", opt.label);
          b.setAttribute("data-status", opt.key);
          if (locked || blocked) {
            b.disabled = true;
          } else {
            b.addEventListener("click", function () {
              var already = b.classList.contains("is-active");
              Array.prototype.forEach.call(group.querySelectorAll(".avail-opt"), function (o) {
                o.classList.remove("is-active");
              });
              if (!already) b.classList.add("is-active"); // click an active option again to clear it
            });
          }
          group.appendChild(b);
        });
        td.appendChild(group);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);

    if (!locked) {
      var foot = document.createElement("div");
      foot.className = "avail-foot weekly-foot";
      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-primary";
      saveBtn.textContent = "שמור אילוצים שבועיים";
      saveBtn.addEventListener("click", function () { saveWeekly(start); });
      foot.appendChild(saveBtn);
      card.appendChild(foot);
    }

    host.appendChild(card);
  }

  function saveWeekly(start) {
    if (isAdmin()) return;
    var startIso = isoOf(start);
    if (isAvailLocked(startIso)) { toast("הגשת האילוצים לשבוע זה ננעלה", false); return; }

    var days = {};
    var blockNight = state.user && state.user.restrictNightShifts;
    var restrictWeekend = weekendRestricted();
    Array.prototype.forEach.call(el.weeklyView.querySelectorAll("[data-weekly-date]"), function (row) {
      var iso = row.getAttribute("data-weekly-date");
      var prefs = {};
      // Force every shift on a Friday/Saturday to "לא זמין" (cannot) for a
      // weekend-restricted trainee, matching the locked grid rows.
      if (restrictWeekend && isWeekendIso(iso)) {
        WEEKLY_SHIFT_ORDER.forEach(function (sid) { prefs[sid] = "cannot"; });
        days[iso] = prefs;
        return;
      }
      Array.prototype.forEach.call(row.querySelectorAll("[data-weekly-shift]"), function (group) {
        var sid = group.getAttribute("data-weekly-shift");
        if (blockNight && sid === "night") return; // restricted trainees never submit nights
        var active = group.querySelector(".avail-opt.is-active");
        if (active) prefs[sid] = active.getAttribute("data-status");
      });
      days[iso] = prefs;
    });

    // Attach the explicit Sunday→Saturday bounds of the chosen week so the server
    // scopes the submission to exactly this week block (and the engine later reads
    // back the same window).
    var endDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    api("PUT", "availability", { days: days, startDate: startIso, endDate: isoOf(endDate) }).then(function () {
      return loadWeekly();
    }).then(function () {
      toast("האילוצים השבועיים נשמרו בהצלחה", true);
    }).catch(function (err) {
      if (err && err.status === 423) toast("הגשת האילוצים לשבוע זה ננעלה", false);
      else toast("האילוצים לא נשמרו", false);
    });
  }

  /* ---------------- Availability live matrix (admins) ---------------- */
  function buildAvailMatrix(iso) {
    var trainees = (cache.users || []).filter(function (u) {
      return isTraineeRole(u.role) && (u.status || "Approved") === "Approved";
    });

    // Group the day's submitted entries by email → { shiftType: preference }.
    var byEmail = {};
    var entries = (cache.day && cache.day.iso === iso) ? cache.day.availEntries : [];
    (entries || []).forEach(function (e) {
      var key = (e.email || "").toLowerCase();
      if (!byEmail[key]) byEmail[key] = {};
      byEmail[key][e.shiftType] = e.preference;
    });

    var card = document.createElement("section");
    card.className = "avail-card avail-matrix-card";

    var head = document.createElement("div");
    head.className = "avail-card-head";
    var h4 = document.createElement("h4");
    h4.textContent = "אילוצי החניכים — תצוגה חיה";
    head.appendChild(h4);
    var deadline = getWeekDeadline(iso);
    var hint = document.createElement("span");
    hint.className = "avail-hint";
    hint.textContent = deadline
      ? "מועד נעילה לשבוע: " + formatDeadline(deadline)
      : "נעילת הגשות אינה פעילה";
    head.appendChild(hint);
    card.appendChild(head);

    var submitted = trainees.filter(function (u) {
      var dm = byEmail[(u.email || "").toLowerCase()];
      return dm && Object.keys(dm).length > 0;
    });

    if (submitted.length === 0) {
      var empty = document.createElement("p");
      empty.className = "avail-empty";
      empty.textContent = "אף חניך לא הגיש אילוצים ליום זה עדיין.";
      card.appendChild(empty);
      return card;
    }

    var tableWrap = document.createElement("div");
    tableWrap.className = "avail-matrix-wrap";
    var table = document.createElement("table");
    table.className = "avail-matrix";

    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    var hName = document.createElement("th");
    hName.textContent = "חניך/ה";
    htr.appendChild(hName);
    SHIFT_TYPES.forEach(function (st) {
      var th = document.createElement("th");
      th.textContent = "משמרת " + st.label;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    submitted.forEach(function (u) {
      var dm = byEmail[(u.email || "").toLowerCase()] || {};
      var tr = document.createElement("tr");
      var tdName = document.createElement("td");
      tdName.className = "avail-matrix-name";
      tdName.textContent = u.name;
      tr.appendChild(tdName);
      SHIFT_TYPES.forEach(function (st) {
        var td = document.createElement("td");
        var status = dm[st.id];
        if (status) {
          var pill = document.createElement("span");
          pill.className = "avail-cell " + availClass(status);
          pill.textContent = availLabel(status);
          td.appendChild(pill);
        } else {
          td.className = "avail-cell-empty";
          td.textContent = "—";
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    card.appendChild(tableWrap);
    return card;
  }

  function formatDeadline(d) {
    return "יום " + HE_WEEKDAYS[d.getDay()] + " " + d.getDate() + "/" + (d.getMonth() + 1) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ---------------- Smart trainee assignment (admins) ---------------- */
  // The day's submitted availability, indexed { shiftType: { emailLower: pref } }.
  // Built from the same entries the live matrix reads, so the picker reflects
  // exactly what trainees submitted for this date.
  function dayAvailByShift(iso) {
    var out = {};
    var entries = (cache.day && cache.day.iso === iso) ? cache.day.availEntries : [];
    (entries || []).forEach(function (e) {
      var bucket = out[e.shiftType] || (out[e.shiftType] = {});
      bucket[(e.email || "").toLowerCase()] = e.preference;
    });
    return out;
  }

  // Approved, non-admin accounts — the trainees eligible for assignment.
  function approvedTrainees() {
    return (cache.users || []).filter(function (u) {
      return isTraineeRole(u.role) && (u.status || "Approved") === "Approved";
    });
  }

  // Set of every name that belongs to a registered account or the quick-select
  // roster, lowercased for lookup. Used to tell an "external" scheduled name (a
  // guest / one-off cover typed straight into the monthly matrix) from a real user.
  function knownPersonNames() {
    var set = {};
    (cache.users || []).forEach(function (u) { var n = (u.name || "").trim().toLowerCase(); if (n) set[n] = true; });
    (cache.roster || []).forEach(function (r) { var n = (r.name || "").trim().toLowerCase(); if (n) set[n] = true; });
    return set;
  }
  // True when `name` is filled in but matches no registered user or roster entry —
  // i.e. a free-text external name saved from the creatable picker.
  function isExternalName(name) {
    var n = (name || "").trim();
    if (!n) return false;
    return !knownPersonNames()[n.toLowerCase()];
  }

  // Bucket every trainee by their preference for this date + shift type so the
  // picker can list them prioritized: prefer → avoid → none → cannot.
  function groupTraineesForShift(iso, shiftType) {
    var availMap = dayAvailByShift(iso)[shiftType] || {};
    var groups = { prefer: [], avoid: [], none: [], cannot: [] };
    approvedTrainees().forEach(function (u) {
      var pref = availMap[(u.email || "").toLowerCase()];
      if (pref === "prefer" || pref === "avoid" || pref === "cannot") groups[pref].push(u);
      else groups.none.push(u);
    });
    Object.keys(groups).forEach(function (k) {
      groups[k].sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "he"); });
    });
    return groups;
  }

  // Names already placed in any slot of this station today (live DOM values), used
  // to flag a trainee who would be double-booked on the same station.
  function stationAssignedNames(station) {
    var set = {};
    SLOTS.forEach(function (s) {
      var f = byId("f_" + station.id + "_" + s.key);
      var v = f ? f.value.trim() : "";
      if (v) set[v] = true;
    });
    return set;
  }

  // Anchor the (fixed-position) popover just below the trigger button. The shift
  // card clips overflow, so the popover lives on <body> and is placed manually.
  function positionAssignPop(pop, btn) {
    var r = btn.getBoundingClientRect();
    var w = pop.offsetWidth || 290;
    var left = r.right - w;            // RTL: hang from the button's end edge
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    pop.style.left = left + "px";
    pop.style.top = (r.bottom + 6) + "px";
  }

  function closeAssignPicker() {
    var a = state.assign;
    if (!a) return;
    document.removeEventListener("click", a.onDoc, true);
    window.removeEventListener("scroll", a.onScroll, true);
    window.removeEventListener("resize", a.onScroll, true);
    if (a.pop && a.pop.parentNode) a.pop.parentNode.removeChild(a.pop);
    state.assign = null;
  }

  function openAssignPicker(btn, iso, station, slot) {
    if (!isAdmin()) return;
    var field = "f_" + station.id + "_" + slot.key;
    var wasOpen = state.assign && state.assign.field === field;
    closeAssignPicker();
    if (wasOpen) return; // a second click on the same button toggles it closed

    var pop = buildAssignPop(iso, station, slot);
    document.body.appendChild(pop);
    positionAssignPop(pop, btn);

    var onDoc = function (e) {
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      closeAssignPicker();
    };
    var onScroll = function () { positionAssignPop(pop, btn); };
    document.addEventListener("click", onDoc, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    state.assign = { field: field, pop: pop, onDoc: onDoc, onScroll: onScroll };

    // Pull the latest counts for THIS day's week so each trainee's weekly ratio
    // is accurate, then swap the list body in place (popover/position stay put).
    refreshWeekCounts(iso).then(function () {
      if (!state.assign || state.assign.field !== field) return; // closed / moved on
      var old = pop.querySelector(".assign-pop-body");
      if (old) pop.replaceChild(buildAssignBody(iso, station, slot), old);
      positionAssignPop(pop, btn);
    });
  }

  function buildAssignPop(iso, station, slot) {
    var pop = document.createElement("div");
    pop.className = "assign-pop";

    var head = document.createElement("div");
    head.className = "assign-pop-head";
    var titles = document.createElement("div");
    titles.className = "assign-pop-titles";
    var title = document.createElement("span");
    title.className = "assign-pop-title";
    title.innerHTML = '<span class="shift-band ' + station.shift + '"></span>';
    title.appendChild(document.createTextNode("שיבוץ " + slot.label + " · משמרת " + shiftLabel(station.shift)));
    var sub = document.createElement("span");
    sub.className = "assign-pop-sub";
    sub.textContent = station.name; // user data → textContent
    titles.appendChild(title);
    titles.appendChild(sub);

    var x = document.createElement("button");
    x.type = "button";
    x.className = "assign-pop-x";
    x.setAttribute("aria-label", "סגירה");
    x.textContent = "×";
    x.addEventListener("click", closeAssignPicker);

    head.appendChild(titles);
    head.appendChild(x);
    pop.appendChild(head);

    pop.appendChild(buildAssignBody(iso, station, slot));
    return pop;
  }

  // The scrollable list of trainees, grouped by submitted preference. Split out
  // from buildAssignPop so it can be rebuilt in place once the live weekly shift
  // counts arrive, without disturbing the popover's position.
  function buildAssignBody(iso, station, slot) {
    var body = document.createElement("div");
    body.className = "assign-pop-body";

    var groups = groupTraineesForShift(iso, station.shift);
    var assigned = stationAssignedNames(station);
    var total = 0;

    ASSIGN_GROUPS.forEach(function (g) {
      var members = groups[g.key];
      if (!members || !members.length) return;
      total += members.length;

      var section = document.createElement("div");
      section.className = "assign-group";
      var gt = document.createElement("div");
      gt.className = "assign-group-title " + g.cls;
      gt.textContent = g.title + " (" + members.length + ")";
      section.appendChild(gt);

      members.forEach(function (u) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "assign-item " + g.cls;

        var nm = document.createElement("span");
        nm.className = "assign-item-name";
        nm.textContent = u.name; // user data → textContent
        item.appendChild(nm);

        // Personal progress so the admin can prioritise trainees who are still
        // short of their own target. Same colour rule as the users-table badge.
        item.appendChild(buildAssignQuota(u));

        if (assigned[u.name]) {
          var busy = document.createElement("span");
          busy.className = "assign-item-busy";
          busy.textContent = "כבר משובץ/ת";
          item.appendChild(busy);
        }
        if (g.tag) {
          var tag = document.createElement("span");
          tag.className = "assign-item-tag";
          tag.textContent = g.tag;
          item.appendChild(tag);
        }

        if (g.key === "cannot") {
          // Blocked: cannot be assigned, but still shown so the admin sees why.
          item.disabled = true;
          item.title = "החניך/ה סימן/ה שאינו/ה יכול/ה לעבוד במשמרת זו";
        } else {
          (function (name) {
            item.addEventListener("click", function () {
              closeAssignPicker();
              quickAssign(iso, station, slot.key, name);
            });
          })(u.name);
        }
        section.appendChild(item);
      });
      body.appendChild(section);
    });

    if (total === 0) {
      var empty = document.createElement("p");
      empty.className = "assign-empty";
      empty.textContent = "אין חניכים מאושרים לשיבוץ.";
      body.appendChild(empty);
    }

    return body;
  }

  // Compact "current / target" pill for the smart picker. Green when the trainee
  // has met their weekly target, orange while below, neutral with no target. The
  // count is for the week of the day being assigned (cache.weekCounts).
  function buildAssignQuota(u) {
    var count = cache.weekCounts[u.name] || 0;
    var target = userTarget(u);
    var q = document.createElement("span");
    q.className = "assign-item-quota";
    if (target > 0) {
      q.classList.add(count >= target ? "ok" : "low");
      q.textContent = count + " / " + target;
      q.title = "שובץ/ה ל-" + count + " מתוך יעד של " + target + " משמרות בשבוע";
    } else {
      q.classList.add("neutral");
      q.textContent = String(count);
      q.title = "שובץ/ה ל-" + count + " משמרות השבוע (לא הוגדר יעד אישי)";
    }
    return q;
  }

  // One-click placement: write the chosen name into the slot and persist just this
  // station's row, preserving whatever the admin already typed in its other slots.
  // Works for both global stations and per-day custom shifts (routed by isCustom).
  function quickAssign(iso, station, slotKey, name) {
    if (!isAdmin()) return;
    var input = byId("f_" + station.id + "_" + slotKey);
    if (input) input.value = name;

    var entry = {};
    SLOTS.forEach(function (s) {
      var f = byId("f_" + station.id + "_" + s.key);
      entry[s.key] = f ? f.value.trim() : "";
    });
    var noteField = byId("f_" + station.id + "_note");
    entry.note = noteField ? noteField.value.trim() : "";

    var payload = {};
    if (station.isCustom) {
      var custom = {}; custom[station.dbId] = entry; payload.custom = custom;
    } else {
      var shifts = {}; shifts[station.dbId] = entry; payload.shifts = shifts;
    }
    api("PUT", "schedules/" + iso, payload).then(function () {
      if (cache.day && cache.day.iso === iso) {
        if (station.isCustom) {
          (cache.day.custom || []).forEach(function (c) {
            if (c.id === station.dbId) {
              c.driver = entry.driver; c.medic = entry.medic;
              c.intern1 = entry.intern1; c.intern2 = entry.intern2; c.note = entry.note;
            }
          });
        } else {
          cache.day.shifts = cache.day.shifts || {};
          cache.day.shifts[station.dbId] = entry;
        }
      }
      toast("שובץ/ה " + name + " בהצלחה", true);
      refreshShiftCounts(); // keep the admin's per-trainee counter in sync
      return loadMonth(); // refresh the calendar's assignment indicator
    }).catch(function () {
      toast("השיבוץ נכשל. נסו שוב", false);
    });
  }

  /* ---------------- Automated scheduling engine (admin) ---------------- */
  // The engine lives in its own tab ("מנוע שיבוץ אוטומטי"). Loading the tab
  // refreshes the trainee picker against the current roster and stamps the
  // active month; the report area persists the last run until the month changes.
  function loadEngine() {
    if (!isAdmin() || !el.tabEngine) return Promise.resolve();
    closeAssignPicker();
    if (el.engineMonthLabel) {
      el.engineMonthLabel.textContent = HE_MONTHS[state.viewDate.getMonth()] + " " + state.viewDate.getFullYear();
    }
    // Default the run's target week to the upcoming scheduling week (next week's
    // Sunday) the first time the tab opens; keep any week the admin already chose.
    if (!state.autoWeek) state.autoWeek = upcomingWeekStart();
    syncAutoWeekUI();
    // Keep the submission tracker aligned to the same week, so the admin sees who
    // submitted availability for exactly the week they are about to staff.
    state.subWeek = new Date(state.autoWeek.getFullYear(), state.autoWeek.getMonth(), state.autoWeek.getDate());
    loadSubmissions();
    return api("GET", "users").then(function (list) {
      cache.users = list || cache.users || [];
      populateAutoAssignTrainees();
    }).catch(function () {
      populateAutoAssignTrainees();
    });
  }

  // Reflect state.autoWeek in the picker: the date input shows the week's Sunday,
  // and the readout shows the resolved Sunday–Saturday range (e.g. "05/07 – 11/07").
  function syncAutoWeekUI() {
    var sun = state.autoWeek || upcomingWeekStart();
    var sat = new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + 6);
    if (el.autoWeekInput) el.autoWeekInput.value = isoOf(sun);
    if (el.autoWeekRange) {
      var fmt = function (d) { return pad(d.getDate()) + "/" + pad(d.getMonth() + 1); };
      el.autoWeekRange.textContent = fmt(sun) + " – " + fmt(sat);
    }
  }

  // Picker change → snap the chosen date back to its week's Sunday, then keep the
  // submission tracker on the same week so both views stay in step.
  function onAutoWeekPick() {
    var v = el.autoWeekInput && el.autoWeekInput.value;
    if (!v) { syncAutoWeekUI(); return; }
    state.autoWeek = weekStartOf(v);
    syncAutoWeekUI();
    state.subWeek = new Date(state.autoWeek.getFullYear(), state.autoWeek.getMonth(), state.autoWeek.getDate());
    loadSubmissions();
  }

  // The engine shares state.viewDate with the rest of the app. Changing months
  // here clears any stale report so it never describes a different month, and
  // moves the week picker (and the submission tracker it drives) to the new
  // month's first week.
  function stepEngineMonth(delta) {
    closeAssignPicker();
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + delta, 1);
    state.autoWeek = weekStartOf(matrixMonthStr() + "-01");
    clearEngineReport();
    loadEngine();
  }

  /* ---------------- Weekly availability submission tracking (admin) ---------------- */
  // Collapsible panel showing who has / hasn't submitted availability for the
  // tracked week. The week is independent of the engine's target month so an
  // admin can audit any week's submissions before running the engine.
  function toggleSubmissionPanel() {
    if (!el.submissionPanel || !el.submissionToggle) return;
    var show = el.submissionPanel.hidden;
    el.submissionPanel.hidden = !show;
    el.submissionToggle.setAttribute("aria-expanded", show ? "true" : "false");
    if (show) loadSubmissions(); // refresh on open so it's never stale
  }

  function stepSubmissionWeek(delta) {
    var base = state.subWeek || weekStartOf(todayIso());
    state.subWeek = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta * 7);
    loadSubmissions();
  }

  // ISO 'YYYY-MM-DD' for the tracked week's Sunday.
  function submissionWeekIso() {
    return isoOf(state.subWeek || weekStartOf(todayIso()));
  }

  // Human label for the tracked week range, e.g. "26/06 – 02/07".
  function submissionWeekLabel() {
    var s = state.subWeek || weekStartOf(todayIso());
    var e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
    var fmt = function (d) { return pad(d.getDate()) + "/" + pad(d.getMonth() + 1); };
    return fmt(s) + " – " + fmt(e);
  }

  // Fetch and render the submitted / pending split for the tracked week.
  function loadSubmissions() {
    if (!isAdmin() || !el.submissionPanel) return Promise.resolve();
    if (el.submissionWeekLabel) el.submissionWeekLabel.textContent = submissionWeekLabel();
    return api("GET", "availability/submissions?week=" + submissionWeekIso()).then(function (d) {
      renderSubmissions((d && d.submitted) || [], (d && d.pending) || []);
    }).catch(function () {
      renderSubmissions([], []);
    });
  }

  // Build the two lists plus the collapsed-header summary.
  function renderSubmissions(submitted, pending) {
    state.subPending = pending.map(function (u) { return u.name; });

    var fill = function (listEl, people, emptyText) {
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!people.length) {
        var li = document.createElement("li");
        li.className = "submission-empty";
        li.textContent = emptyText;
        listEl.appendChild(li);
        return;
      }
      people.forEach(function (u) {
        var li = document.createElement("li");
        li.className = "submission-item";
        var nm = document.createElement("span");
        nm.className = "submission-name";
        nm.textContent = u.name; // user data → textContent (injection-safe)
        li.appendChild(nm);
        listEl.appendChild(li);
      });
    };

    fill(el.submissionSubmittedList, submitted, "אף אחד עדיין לא הגיש לשבוע זה.");
    fill(el.submissionPendingList, pending, "כל המלווים הגישו זמינות לשבוע זה. ");

    if (el.submissionSubmittedCount) el.submissionSubmittedCount.textContent = "(" + submitted.length + ")";
    if (el.submissionPendingCount) el.submissionPendingCount.textContent = "(" + pending.length + ")";
    if (el.submissionCopyPending) el.submissionCopyPending.disabled = !pending.length;
    if (el.submissionSummary) {
      el.submissionSummary.textContent = "הגישו " + submitted.length + " · טרם הגישו " + pending.length;
    }
  }

  // Copy the pending trainees' names to the clipboard so the admin can paste them
  // into a reminder message. Falls back to a textarea selection where the async
  // Clipboard API is unavailable.
  function copyPendingNames() {
    var names = (state.subPending || []).join("\n");
    if (!names) { toast("אין מלווים שטרם הגישו לשבוע זה", true); return; }
    var done = function () { toast("השמות הועתקו (" + state.subPending.length + ")", true); };
    var failed = function () { toast("ההעתקה נכשלה", false); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(names).then(done).catch(failed);
      return;
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = names;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) { failed(); }
  }

  function clearEngineReport() {
    if (el.engineReport) el.engineReport.innerHTML = "";
  }

  /* ---------------- Bulk schedule import ("ייבוא סידור ממד״א") ---------------- */
  // Stage the chosen file (from the picker or a drop) and reflect it in the UI.
  // Nothing is sent yet — the import only fires when the admin presses the button.
  function onImportFileSelected(file) {
    if (!isAdmin()) return;
    state.importFile = file || null;
    if (el.importFileName) el.importFileName.textContent = file ? file.name : "";
    if (el.importBtn) el.importBtn.disabled = !file;
  }

  // Clear the staged file and reset the dropzone after an import finishes.
  function clearImportFile() {
    state.importFile = null;
    if (el.importFile) el.importFile.value = "";
    if (el.importFileName) el.importFileName.textContent = "";
    if (el.importBtn) el.importBtn.disabled = true;
  }

  // Take the staged file, turn it into the structured assignment array the backend
  // expects, POST it to /schedule/import-bulk, then refresh the view and confirm.
  function runImport() {
    if (!isAdmin()) return;
    var file = state.importFile;
    if (!file) { toast("בחרו קובץ לייבוא", false); return; }

    var btn = el.importBtn;
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "מייבא…"; }

    var month = matrixMonthStr();

    // ----------------------------------------------------------------------
    //  Vision / Parser API integration point.
    //
    //  The raw uploaded file (screenshot / Excel / PDF) is captured in `file`.
    //  This is where we will later hand it to a third-party Vision/Parser API
    //  that converts the official MDA schedule image into the structured array
    //  the backend consumes. Each parsed slot must match this exact signature:
    //
    //    {
    //      date: "YYYY-MM-DD",
    //      shiftType: "בוקר" | "ערב" | "לילה",
    //      stationName: "רמת גן" | "בני ברק" | string,
    //      paramedicName: string,   // פראמדיק/ית
    //      driverName: string       // נהג/ת
    //    }
    //
    //  Example of the eventual wiring (replaces the stub below):
    //
    //    var form = new FormData();
    //    form.append("file", file);
    //    form.append("month", month);
    //    parseScheduleFile(form)
    //      .then(function (assignments) { return dispatchImport(assignments); })
    //      .then(onImportSuccess)
    //      .catch(onImportError);
    //
    //  where parseScheduleFile() POSTs the file to the Vision/Parser endpoint
    //  and resolves to the assignment array described above.
    // ----------------------------------------------------------------------

    // STUB: stand-in for the parser output so the end-to-end flow (upsert →
    // refresh → toast) works today. Swap this line for the real parse call above.
    var assignments = buildStubImportAssignments(month);

    api("POST", "schedule/import-bulk", assignments).then(function () {
      // Pull the freshly imported assignments into whatever view is open.
      refreshActiveView();
      refreshShiftCounts();
      toast("הסידור המרוכז יובא ועודכן בהצלחה!", true);
      clearImportFile();
    }).catch(function (err) {
      toast((err && err.status === 403) ? "אין הרשאה לייבוא סידור" : "ייבוא הסידור נכשל", false);
    }).then(function () {
      if (btn) { btn.textContent = label; btn.disabled = !state.importFile; }
    });
  }

  // Representative placeholder payload for the viewed month, standing in for the
  // Vision/Parser output until that API is wired up in runImport(). Mirrors the
  // exact slot signature the backend validates.
  function buildStubImportAssignments(month) {
    var d1 = month + "-01";
    var d2 = month + "-02";
    return [
      { date: d1, shiftType: "בוקר", stationName: "רמת גן",  paramedicName: "אורי בן־חיים", driverName: "נועה שגב" },
      { date: d1, shiftType: "ערב",  stationName: "בני ברק", paramedicName: "שירה אלמוג",   driverName: "יותם קריב" },
      { date: d2, shiftType: "לילה", stationName: "רמת גן",  paramedicName: "אורי בן־חיים", driverName: "יותם קריב" }
    ];
  }

  // Show which isolated day the parsed roster will be written to.
  function syncDailyImportDay() {
    var iso = normalizeWhiteAmbulanceDate();
    if (el.dailyImportDay) el.dailyImportDay.textContent = "ייבוא ה‑Excel הפרטי ייכתב ליום: " + iso;
    if (el.dailyImportDayImport) el.dailyImportDayImport.textContent = "ייבוא ה‑Excel הפרטי ייכתב ליום: " + iso;
    if (el.whiteRequestDate) el.whiteRequestDate.value = iso;
  }

  // Upload the chosen Excel workbook to the backend, which reads the roster off
  // its grid, applies the station-routing rules and upserts the נהג אט״ן /
  // פראמדיק crew into the day's schedule; then refresh stations + the day grid so
  // the names show at once.
  function runDailyImport(file) {
    if (!isPrivateDailyImportAdmin()) return;
    var iso = normalizeWhiteAmbulanceDate();
    if (!file) return;
    var isExcel = /\.(xlsx|xls)$/i.test(file.name || "") ||
      file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.type === "application/vnd.ms-excel";
    if (!isExcel) {
      toast("יש להעלות קובץ Excel בלבד (xlsx)", false);
      clearDailyImportFile();
      return;
    }

    if (el.dailyImportFileName) el.dailyImportFileName.textContent = file.name || "";
    if (el.dailyImportDropzone) el.dailyImportDropzone.classList.add("is-loading");

    var form = new FormData();
    form.append("file", file);
    form.append("date", iso);

    uploadDailyExcel(form).then(function (res) {
      var n = (res && typeof res.imported === "number") ? res.imported : 0;
      var rgInvalid = !!(res && res.rgDayInvalid);
      var refresh = (el.tabWhiteImport && !el.tabWhiteImport.hidden) ? loadWhiteImportPanel() : loadWhiteAmbulancePanel();
      return refresh.then(function () {
        refreshShiftCounts();
        if (rgInvalid) toast("בלוק רמת גן 09:00-17:00 דולג — שם הפראמדיק בקובץ אינו שם מלא תקין", false);
        else if (n > 0) toast("הסידור היומי הפרטי עודכן באזור הניהול (" + n + " רשומות)", true);
        else toast("לא נמצאו רשומות אט״ן פרטיות ליום זה בקובץ", false);
      });
    }).catch(function (err) {
      var msg = "עיבוד קובץ הסידור היומי נכשל";
      if (err && err.status === 403) msg = "אין הרשאה לעיבוד הסידור";
      else if (err && err.status === 422) msg = "לא ניתן לקרוא את קובץ ה‑Excel";
      toast(msg, false);
    }).then(function () {
      clearDailyImportFile();
    });
  }

  // Clear the staged workbook + its filename and drop the dropzone's loading state.
  function clearDailyImportFile() {
    if (el.dailyImportFile) el.dailyImportFile.value = "";
    if (el.dailyImportFileName) el.dailyImportFileName.textContent = "";
    if (el.dailyImportDropzone) el.dailyImportDropzone.classList.remove("is-loading");
  }

  // POST the multipart Excel payload to the daily-import endpoint. The shared api()
  // helper only speaks JSON, so this sends FormData directly (the browser sets the
  // multipart boundary) while reusing the same bearer token + error shape.
  function uploadDailyExcel(form) {
    if (state.demoMode) {
      var demoErr = new Error("demo mode — offline");
      demoErr.status = 0;
      return Promise.reject(demoErr);
    }
    var headers = {};
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    return fetch("/api/schedule/import-daily-excel", { method: "POST", headers: headers, body: form }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ("HTTP " + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // Rebuild the מלווה multi-select from the approved trainees. Called whenever the
  // engine tab loads so the list always tracks the current roster.
  function populateAutoAssignTrainees() {
    if (!el.autoAssignList) return;
    el.autoAssignList.innerHTML = "";
    var list = approvedTrainees();
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "aa-empty";
      empty.textContent = "אין מלווים מאושרים לשיבוץ.";
      el.autoAssignList.appendChild(empty);
    } else {
      list.forEach(function (u) {
        var lab = document.createElement("label");
        lab.className = "aa-opt";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "aa-trainee";
        cb.value = String(u.id);
        cb.addEventListener("change", syncAutoAssignAll);
        var span = document.createElement("span");
        span.textContent = u.name; // user data → textContent (injection-safe)
        lab.appendChild(cb);
        lab.appendChild(span);
        el.autoAssignList.appendChild(lab);
      });
    }
    if (el.autoAssignAll) el.autoAssignAll.checked = false;
    syncAutoAssignAll();
  }

  // Every מלווה checkbox node, as a real array.
  function autoAssignBoxes() {
    if (!el.autoAssignList) return [];
    return Array.prototype.slice.call(el.autoAssignList.querySelectorAll(".aa-trainee"));
  }

  // The trainee ids to send. None selected, or all selected, both mean "process
  // everyone" — sent as an empty array per the endpoint contract.
  function autoAssignPayloadIds() {
    var boxes = autoAssignBoxes();
    var ids = [];
    boxes.forEach(function (cb) { if (cb.checked) ids.push(Number(cb.value)); });
    if (!ids.length || ids.length === boxes.length) return [];
    return ids;
  }

  // Refresh the chip on the toggle button to reflect the current selection.
  function syncAutoAssignAll() {
    var boxes = autoAssignBoxes();
    var checked = boxes.filter(function (cb) { return cb.checked; }).length;
    if (el.autoAssignAll) el.autoAssignAll.checked = boxes.length > 0 && checked === boxes.length;
    if (el.autoAssignCount) {
      el.autoAssignCount.textContent =
        (checked === 0 || checked === boxes.length) ? "(כל המלווים)" : "(" + checked + ")";
    }
  }

  // "כל המלווים" master checkbox toggles every trainee box at once.
  function onAutoAssignAllToggle() {
    var on = !!(el.autoAssignAll && el.autoAssignAll.checked);
    autoAssignBoxes().forEach(function (cb) { cb.checked = on; });
    syncAutoAssignAll();
  }

  function toggleAutoAssignPanel(open) {
    if (!el.autoAssignPanel || !el.autoAssignToggle) return;
    var show = (open === undefined) ? el.autoAssignPanel.hidden : open;
    el.autoAssignPanel.hidden = !show;
    el.autoAssignToggle.setAttribute("aria-expanded", show ? "true" : "false");
  }

  // Confirm, POST the selected trainee ids, then render a detailed summary
  // report inside the engine tab.
  function runAutoAssign() {
    if (!isAdmin()) return;
    var ids = autoAssignPayloadIds();
    // Strict weekly scope: the run targets exactly the week chosen in the "בחר
    // שבוע לשיבוץ" picker (its Sunday → the following Saturday), never the whole
    // month. Send those explicit ISO bounds so the engine truncates to this week.
    var weekSun = state.autoWeek || upcomingWeekStart();
    var weekSat = new Date(weekSun.getFullYear(), weekSun.getMonth(), weekSun.getDate() + 6);
    var startIso = isoOf(weekSun);
    var endIso = isoOf(weekSat);
    var fmt = function (d) { return pad(d.getDate()) + "/" + pad(d.getMonth() + 1); };
    var weekLabel = fmt(weekSun) + " – " + fmt(weekSat);
    var who = ids.length ? (ids.length + " מלווים נבחרים") : "כל המלווים הזמינים";
    if (!window.confirm(
      "להפעיל את מנוע השיבוץ עבור " + who + " לשבוע " + weekLabel + "?\n" +
      "יתמלאו רק משבצות מלווה א׳ / מלווה ב׳ הפנויות בשבוע זה, לפי העדפות הזמינות והיעד השבועי. שיבוצים קיימים יישמרו."
    )) return;

    toggleAutoAssignPanel(false);
    var btn = el.autoAssignBtn;
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "משבץ…"; }
    if (el.engineReport) {
      el.engineReport.innerHTML = '<p class="engine-loading">המנוע פועל…</p>';
    }

    api("POST", "schedules/auto-assign", {
      traineeIds: ids,
      month: matrixMonthStr(),
      startDate: startIso,
      endDate: endIso
    }).then(function (res) {
      renderEngineReport(res || {});
      // Scope the monthly matrix to exactly the week just staffed: jump its month
      // to the run's Sunday and flag the focus week so the grid renders only those
      // seven rows on the next visit to "שיבוץ חודשי", not the whole month.
      state.matrixFocusWeek = (res && res.startDate) || startIso;
      state.viewDate = new Date(weekSun.getFullYear(), weekSun.getMonth(), 1);
      // Keep the cached week grid counts fresh for the next visit to "שיבוץ חודשי".
      refreshShiftCounts();
    }).catch(function (err) {
      clearEngineReport();
      toast((err && err.status === 403) ? "אין הרשאה לשיבוץ אוטומטי" : "השיבוץ האוטומטי נכשל", false);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    });
  }

  // ISO 'YYYY-MM-DD' → 'DD/MM' for the placement log.
  function shortDate(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "/" + p[1] : String(iso || "");
  }

  // Render the post-assignment summary: a headline strip plus one card per
  // trainee carrying their assigned-vs-target tally and a detailed placement log.
  function renderEngineReport(res) {
    if (!el.engineReport) return;
    el.engineReport.innerHTML = "";

    var monthLabel = HE_MONTHS[state.viewDate.getMonth()] + " " + state.viewDate.getFullYear();
    // Prefer the exact week the engine ran on (echoed back as startDate/endDate)
    // so the report header names the scoped week, not the whole month.
    var scopeLabel = monthLabel;
    if (res.startDate && res.endDate) {
      var sp = String(res.startDate).split("-");
      var ep = String(res.endDate).split("-");
      if (sp.length === 3 && ep.length === 3) {
        scopeLabel = sp[2] + "/" + sp[1] + " – " + ep[2] + "/" + ep[1];
      }
    }
    var assigned = Number(res.assigned) || 0;
    var remaining = Number(res.remaining) || 0;
    var rows = Array.isArray(res.byTrainee) ? res.byTrainee : [];

    var head = document.createElement("div");
    head.className = "engine-report-head";
    var h3 = document.createElement("h3");
    h3.className = "engine-report-title";
    h3.textContent = "דוח שיבוץ — " + scopeLabel;
    head.appendChild(h3);

    var stats = document.createElement("div");
    stats.className = "engine-stats";
    [
      { v: assigned, l: "משמרות שובצו" },
      { v: remaining, l: "משבצות נותרו פנויות" },
      { v: rows.length, l: "מלווים נבדקו" }
    ].forEach(function (s) {
      var box = document.createElement("div");
      box.className = "engine-stat";
      var num = document.createElement("span");
      num.className = "engine-stat-num";
      num.textContent = String(s.v);
      var cap = document.createElement("span");
      cap.className = "engine-stat-cap";
      cap.textContent = s.l;
      box.appendChild(num);
      box.appendChild(cap);
      stats.appendChild(box);
    });
    head.appendChild(stats);
    el.engineReport.appendChild(head);

    if (!rows.length) {
      var none = document.createElement("p");
      none.className = "engine-empty";
      none.textContent = "לא נמצאו מלווים עם יעד שבועי לשיבוץ. ודאו שהוגדר יעד משמרות שבועי ושהוגשו העדפות זמינות.";
      el.engineReport.appendChild(none);
      return;
    }

    rows.forEach(function (t) {
      var card = document.createElement("div");
      card.className = "engine-card";

      var ch = document.createElement("div");
      ch.className = "engine-card-head";

      var name = document.createElement("span");
      name.className = "engine-card-name";
      name.textContent = t.name; // user data → textContent (injection-safe)
      ch.appendChild(name);

      var tally = document.createElement("span");
      tally.className = "engine-card-tally";
      var newCount = Number(t.assigned) || 0;
      var total = Number(t.count) || 0;
      var weeklyTarget = Number(t.weeklyTarget != null ? t.weeklyTarget : t.target) || 0;
      var peakWeek = Number(t.peakWeek) || 0;
      // Weekly quota model: show what this run added, the month total, and the
      // busiest week against the weekly cap.
      tally.textContent = "שובצו " + newCount + " משמרות בריצה זו · סה״כ " + total + " בחודש · שבוע עמוס " + peakWeek + " מתוך יעד שבועי " + weeklyTarget;
      if (weeklyTarget > 0 && peakWeek >= weeklyTarget) tally.classList.add("is-met");
      ch.appendChild(tally);
      card.appendChild(ch);

      var placements = Array.isArray(t.placements) ? t.placements : [];
      if (!placements.length) {
        var em = document.createElement("p");
        em.className = "engine-card-empty";
        em.textContent = "לא שובצו משמרות חדשות בריצה זו.";
        card.appendChild(em);
      } else {
        var table = document.createElement("table");
        table.className = "engine-log";
        var thead = document.createElement("thead");
        var htr = document.createElement("tr");
        ["תאריך", "משמרת", "תחנה", "מיקום", "העדפה"].forEach(function (h) {
          var th = document.createElement("th");
          th.textContent = h;
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        var tbody = document.createElement("tbody");
        placements.slice().sort(function (a, b) {
          return String(a.date).localeCompare(String(b.date));
        }).forEach(function (p) {
          var tr = document.createElement("tr");
          if (p.mentor) tr.className = "is-mentor";
          var slotText = (p.slotLabel || "") + (p.mentor ? " · שובץ לצד הטיוטור" : "");
          var cells = [
            shortDate(p.date),
            p.shiftLabel || p.shift || "",
            p.station || "",
            slotText,
            p.preference === "avoid" ? "מעדיף שלא" : (p.preference === "prefer" ? "מעדיף" : "")
          ];
          cells.forEach(function (val, idx) {
            var td = document.createElement("td");
            td.textContent = val;
            if (idx === 4 && p.preference === "avoid") td.className = "pref-avoid";
            if (idx === 4 && p.preference === "prefer") td.className = "pref-prefer";
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        card.appendChild(table);
      }

      el.engineReport.appendChild(card);
    });
  }

  /* ---------------- Monthly matrix (admin) ---------------- */
  // A flat month-on-one-screen grid: one row per calendar day, one column per
  // station (grouped under its shift type), focused on rapid intern assignment.
  // Reads everyone's saved assignments via the admin matrix endpoint; each change
  // persists through the same PUT /api/schedules/:date the day view uses, so it
  // cascades into "המשמרות שלי" and the monthly counters automatically.
  function matrixMonthStr() {
    return state.viewDate.getFullYear() + "-" + pad(state.viewDate.getMonth() + 1);
  }

  function stepMatrixMonth(delta) {
    closeAssignPicker();
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + delta, 1);
    loadMatrix();
  }

  // Stations grouped by shift type in chronological order (night → morning →
  // evening), each group carrying its ordered stations. Empty groups are dropped.
  function matrixShiftGroups() {
    var out = [];
    SHIFT_TYPES.forEach(function (st) {
      var members = (cache.stations || []).filter(function (s) { return s.shift === st.id; });
      if (members.length) out.push({ shift: st.id, label: st.label, stations: members });
    });
    return out;
  }

  // Flat ordered station list matching the column order of the grouped header.
  function matrixStationOrder(groups) {
    var out = [];
    groups.forEach(function (g) { g.stations.forEach(function (s) { out.push(s); }); });
    return out;
  }

  // Pull the whole month's grid (everyone's assignments) plus the live per-trainee
  // counts, then render. Admin-only; viewers never reach this tab.
  function loadMatrix() {
    if (!el.matrixWrap) return Promise.resolve();
    if (!isAdmin()) {
      el.matrixWrap.innerHTML = '<p class="matrix-empty">שיבוץ חודשי זמין לעריכה למנהלים ולעורכי סידור בלבד.</p>';
      return Promise.resolve();
    }
    closeAssignPicker();
    var month = matrixMonthStr();
    if (el.matrixMonthLabel) {
      el.matrixMonthLabel.textContent = HE_MONTHS[state.viewDate.getMonth()] + " " + state.viewDate.getFullYear();
    }
    el.matrixWrap.innerHTML = '<p class="matrix-loading">טוען…</p>';
    return refreshStations().then(function () {
      return Promise.all([
        api("GET", contextQuery("schedules?month=" + month + "&matrix=1")),
        api("GET", contextQuery("schedules?counts=1&week=" + weekStartIso(todayIso()))).catch(function () { return { counts: {} }; })
      ]).then(function (res) {
        cache.matrix = (res[0] && res[0].schedules) || {};
        cache.matrixHidden = (res[0] && res[0].hidden) || {};
        // Seed the weekly quota counts (current week) so picker pills render before
        // the per-open refresh narrows them to the clicked day's week.
        cache.weekCounts = (res[1] && res[1].counts) || {};
        cache.matrixAvail = {}; // fresh month — drop any memoized availability
        renderMatrix();
      }).catch(function () {
        cache.matrix = {}; cache.matrixHidden = {};
        renderMatrix();
        toast("טעינת לוח השיבוץ החודשי נכשלה", false);
      });
    });
  }

  function renderMatrix() {
    var host = el.matrixWrap;
    if (!host) return;
    host.innerHTML = "";

    // Top-of-page indicator: visible only while Edit Mode is on, hidden
    // otherwise. Kept in sync here so the pencil toggle (which re-renders)
    // always reflects the current mode.
    var editBanner = byId("matrix-edit-banner");
    if (editBanner) editBanner.hidden = !state.matrixEditMode;

    var groups = matrixShiftGroups();
    if (groups.length === 0) {
      var empty = document.createElement("p");
      empty.className = "matrix-empty";
      empty.textContent = "לא הוגדרו תחנות פעילות. הגדירו תחנות במסך “ניהול תחנות ומשמרות” כדי לבנות את לוח השיבוץ החודשי.";
      host.appendChild(empty);
      return;
    }

    var y = state.viewDate.getFullYear();
    var m = state.viewDate.getMonth();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var today = new Date();
    var isCurMonth = today.getFullYear() === y && today.getMonth() === m;

    // Edit-mode pencil: the grid opens read-only so scanning the month never
    // risks a stray click landing an assignment. Clicking the pencil turns every
    // intern cell into an interactive picker and highlights the icon. A read-only
    // render simply omits the buttons.
    var editing = !!state.matrixEditMode;
    var toolbar = document.createElement("div");
    toolbar.className = "matrix-toolbar";
    toolbar.appendChild(buildEditPencil(editing, function () {
      state.matrixEditMode = !state.matrixEditMode;
      closeAssignPicker();
      renderMatrix();
    }));
    // Global undo — reverts the last scheduling change from either tab.
    toolbar.appendChild(buildUndoButton());
    // Zoom controls — scale the whole grid up/down on demand for dense months.
    toolbar.appendChild(buildMatrixZoomControls());
    // Inline toolbar prompt: only a "click the pencil to edit" hint while in
    // read mode. Once editing, the top-of-page red banner is the single
    // edit-active indicator, so the toolbar hint is left empty to avoid dupes.
    var hint = document.createElement("span");
    hint.className = "matrix-toolbar-hint";
    hint.textContent = editing
      ? ""
      : "מצב צפייה בלבד — לחץ על העיפרון כדי לערוך";
    toolbar.appendChild(hint);
    host.appendChild(toolbar);

    // Week focus: after an engine run the grid scopes to just the staffed week.
    // Resolve its inclusive ISO bounds; if the focus week doesn't intersect the
    // month on screen (e.g. the admin stepped months), drop it and show the month.
    var firstIso = y + "-" + pad(m + 1) + "-01";
    var lastIso = y + "-" + pad(m + 1) + "-" + pad(daysInMonth);
    var focusStartIso = "", focusEndIso = "", focusActive = false;
    if (state.matrixFocusWeek) {
      var fSun = weekStartOf(state.matrixFocusWeek);
      var fSat = new Date(fSun.getFullYear(), fSun.getMonth(), fSun.getDate() + 6);
      focusStartIso = isoOf(fSun);
      focusEndIso = isoOf(fSat);
      if (focusStartIso <= lastIso && focusEndIso >= firstIso) {
        focusActive = true;
      } else {
        state.matrixFocusWeek = null; // stepped away from the focused week
      }
    }

    if (focusActive) {
      var bar = document.createElement("div");
      bar.className = "matrix-focus-bar";
      var fmtMx = function (iso) { var p = iso.split("-"); return p[2] + "/" + p[1]; };
      var lbl = document.createElement("span");
      lbl.className = "matrix-focus-label";
      lbl.textContent = "מציג שבוע " + fmtMx(focusStartIso) + " – " + fmtMx(focusEndIso);
      var clr = document.createElement("button");
      clr.type = "button";
      clr.className = "btn btn-ghost btn-xs matrix-focus-clear";
      clr.textContent = "הצג חודש מלא";
      clr.addEventListener("click", function () { state.matrixFocusWeek = null; renderMatrix(); });
      bar.appendChild(lbl);
      bar.appendChild(clr);
      host.appendChild(bar);
    }

    var table = document.createElement("table");
    table.className = "matrix-table";

    // Header: a shift-group row spanning each group's stations, then a row of the
    // individual station sub-columns. The date/day columns rowspan both.
    var thead = document.createElement("thead");
    var groupRow = document.createElement("tr");
    var dateTh = document.createElement("th");
    dateTh.className = "mx-col-date mx-corner";
    dateTh.rowSpan = 2;
    dateTh.textContent = "תאריך";
    var dayTh = document.createElement("th");
    dayTh.className = "mx-col-day mx-corner";
    dayTh.rowSpan = 2;
    dayTh.textContent = "יום בשבוע";
    groupRow.appendChild(dateTh);
    groupRow.appendChild(dayTh);

    var stationRow = document.createElement("tr");
    groups.forEach(function (g) {
      var gth = document.createElement("th");
      gth.className = "mx-shift-group " + g.shift;
      gth.colSpan = g.stations.length;
      gth.innerHTML = '<span class="shift-band ' + g.shift + '"></span>';
      gth.appendChild(document.createTextNode(g.label));
      groupRow.appendChild(gth);

      g.stations.forEach(function (s) {
        var sth = document.createElement("th");
        sth.className = "mx-station " + g.shift;
        sth.textContent = s.name;
        sth.title = s.name + " · " + s.hours;
        stationRow.appendChild(sth);
      });
    });
    thead.appendChild(groupRow);
    thead.appendChild(stationRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    var stationList = matrixStationOrder(groups);
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = y + "-" + pad(m + 1) + "-" + pad(d);
      // When a week is focused, emit only that week's rows, never the whole month.
      if (focusActive && (iso < focusStartIso || iso > focusEndIso)) continue;
      var dateObj = new Date(y, m, d);
      var dow = dateObj.getDay();

      var tr = document.createElement("tr");
      if (focusActive) tr.classList.add("is-focus-week");
      if (isCurMonth && today.getDate() === d) tr.classList.add("is-today");
      if (dow === 5 || dow === 6) tr.classList.add("is-weekend"); // Israeli weekend

      var tdDate = document.createElement("td");
      tdDate.className = "mx-col-date";
      tdDate.textContent = pad(d) + "/" + pad(m + 1) + "/" + y;
      tr.appendChild(tdDate);

      var tdDay = document.createElement("td");
      tdDay.className = "mx-col-day";
      tdDay.textContent = "יום " + HE_WEEKDAYS[dow];
      tr.appendChild(tdDay);

      stationList.forEach(function (station) {
        var td = document.createElement("td");
        td.className = "mx-cell";
        td.id = matrixCellId(iso, station.id);
        fillMatrixCell(td, iso, station);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Dedicated horizontal/vertical scroll container. The wide grid lives here
    // (never wider than the viewport itself), so on mobile it swipes sideways
    // like a desktop spreadsheet instead of squashing columns into overlap.
    // The toolbar/focus-bar above stay put — only this box scrolls.
    var scroll = document.createElement("div");
    scroll.className = "matrix-scroll";
    var zoomer = document.createElement("div");
    zoomer.className = "matrix-zoomer";
    zoomer.appendChild(table);
    scroll.appendChild(zoomer);
    host.appendChild(scroll);
    applyMatrixZoom();
  }

  // Scale the monthly grid to the current zoom level. We use the CSS `zoom`
  // property rather than `transform: scale()` on purpose: a transform on the
  // table would establish a new containing block and unstick every
  // position: sticky cell — the pinned תאריך / יום columns (and the "today"
  // indicator riding on them) would then scroll away with the stations instead
  // of staying frozen. `zoom` scales the layout box itself, so the pinned
  // columns keep sticking and the scroll container reserves real space for the
  // whole grid automatically (no manual footprint reservation needed).
  function applyMatrixZoom() {
    var host = el.matrixWrap;
    if (!host) return;
    var table = host.querySelector(".matrix-table");
    if (!table) return;
    var zoomer = host.querySelector(".matrix-zoomer");
    var z = state.matrixZoom || 1;
    // Clear any legacy transform-based zoom so it can never re-break stickiness.
    table.style.transform = "";
    table.style.transformOrigin = "";
    table.style.zoom = z === 1 ? "" : String(z);
    // With `zoom` driving the layout, the old scaled-footprint hack is moot.
    if (zoomer) {
      zoomer.style.width = "";
      zoomer.style.height = "";
    }
  }

  // Two compact +/- buttons plus a live percentage readout. Zoom steps by 0.1
  // and clamps to the 0.7–1.3 range; buttons disable at the bounds.
  function buildMatrixZoomControls() {
    var ZOOM_MIN = 0.7, ZOOM_MAX = 1.3, STEP = 0.1;
    var wrap = document.createElement("div");
    wrap.className = "matrix-zoom";

    var minus = document.createElement("button");
    minus.type = "button";
    minus.className = "btn btn-ghost btn-xs matrix-zoom-btn";
    minus.textContent = "−";
    minus.title = "הקטן תצוגה";

    var label = document.createElement("span");
    label.className = "matrix-zoom-label";

    var plus = document.createElement("button");
    plus.type = "button";
    plus.className = "btn btn-ghost btn-xs matrix-zoom-btn";
    plus.textContent = "+";
    plus.title = "הגדל תצוגה";

    var round1 = function (n) { return Math.round(n * 10) / 10; };
    function paint() {
      var z = state.matrixZoom || 1;
      label.textContent = Math.round(z * 100) + "%";
      minus.disabled = z <= ZOOM_MIN + 0.001;
      plus.disabled = z >= ZOOM_MAX - 0.001;
    }
    minus.addEventListener("click", function () {
      state.matrixZoom = Math.max(ZOOM_MIN, round1((state.matrixZoom || 1) - STEP));
      applyMatrixZoom(); paint();
    });
    plus.addEventListener("click", function () {
      state.matrixZoom = Math.min(ZOOM_MAX, round1((state.matrixZoom || 1) + STEP));
      applyMatrixZoom(); paint();
    });
    paint();

    wrap.appendChild(minus);
    wrap.appendChild(label);
    wrap.appendChild(plus);
    return wrap;
  }

  function matrixCellId(iso, stationId) { return "mx_" + iso + "_" + stationId; }

  function matrixCellData(iso, stationId) {
    var day = cache.matrix[iso];
    return (day && day[String(stationId)]) || {};
  }

  function isStationHiddenOn(iso, stationId) {
    var list = cache.matrixHidden[iso];
    if (!list) return false;
    for (var i = 0; i < list.length; i++) { if (list[i] === stationId) return true; }
    return false;
  }

  // (Re)paint a single cell: the two interactive intern slots, plus a muted
  // driver/medic line for context. A station hidden from this date reads as "—".
  function fillMatrixCell(td, iso, station) {
    td.innerHTML = "";
    if (isStationHiddenOn(iso, station.id)) {
      td.classList.add("is-disabled");
      var off = document.createElement("span");
      off.className = "mx-cell-off";
      off.textContent = "—";
      off.title = "המשמרת הוסרה מיום זה";
      td.appendChild(off);
      return;
    }
    td.classList.remove("is-disabled");
    var data = matrixCellData(iso, station.id);

    // Edit mode: inline remove action for this exact date+station only. Uses the
    // same day-scoped hidden-shift API as the day board (does not touch template).
    if (isAdmin() && state.matrixEditMode) {
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "mx-cell-remove btn-icon btn-trash";
      rm.title = "הסרת המשמרת מיום זה";
      rm.setAttribute("aria-label", "הסרת המשמרת " + station.name + " - " + shiftLabel(station.shift) + " מיום זה");
      rm.innerHTML = ICON_TRASH;
      rm.addEventListener("click", function (e) {
        e.stopPropagation();
        matrixHideShift(iso, station, data);
      });
      td.appendChild(rm);
    }

    td.appendChild(buildInternSlot(iso, station, "intern1", data.intern1 || "", "א׳"));
    td.appendChild(buildInternSlot(iso, station, "intern2", data.intern2 || "", "ב׳"));

    var crew = [];
    if (data.driver) crew.push("נהג/ת: " + data.driver);
    if (data.medic) crew.push("פראמדיק/ית: " + data.medic);
    if (crew.length) {
      var meta = document.createElement("div");
      meta.className = "mx-cell-crew";
      meta.textContent = crew.join(" · ");
      meta.title = crew.join(" · ");
      td.appendChild(meta);
    }
  }

  // One intern slot. In edit mode it is a click-to-pick button (name or
  // placeholder) plus, when filled, a quick "×" that drops the trainee. In
  // read-only mode (the default) it renders as a static, unclickable line so the
  // grid is safe to scan without landing accidental assignments.
  function buildInternSlot(iso, station, slotKey, name, ord) {
    var external = isExternalName(name);
    var editing = !!state.matrixEditMode;
    var slot = document.createElement("div");
    slot.className = "mx-slot" + (name ? " is-filled" : " is-empty") + (external ? " is-external" : "") + (editing ? "" : " is-readonly");

    // Read-only rendering: a plain, non-interactive line. Empty slots collapse to
    // a muted dash so a scanned month stays clean rather than button-heavy.
    if (!editing) {
      var view = document.createElement("span");
      view.className = "mx-slot-view";
      var vdot = document.createElement("span");
      vdot.className = "slot-role-dot intern";
      view.appendChild(vdot);
      var vlabel = document.createElement("span");
      vlabel.className = "mx-slot-name";
      if (name) {
        vlabel.textContent = name;
      } else {
        vlabel.classList.add("is-placeholder");
        vlabel.textContent = "—";
      }
      view.appendChild(vlabel);
      if (external) {
        var vbadge = document.createElement("span");
        vbadge.className = "mx-ext-badge";
        vbadge.textContent = "מתנדב";
        vbadge.title = "שם מתנדב — אינו משתמש רשום במערכת";
        view.appendChild(vbadge);
      }
      view.title = (name || ("מלווה " + ord)) + " · " + station.name + " · משמרת " + shiftLabel(station.shift);
      slot.appendChild(view);
      return slot;
    }

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mx-slot-pick";
    btn.title = "שיבוץ מלווה " + ord + " · " + station.name + " · משמרת " + shiftLabel(station.shift);
    var dot = document.createElement("span");
    dot.className = "slot-role-dot intern";
    btn.appendChild(dot);
    var label = document.createElement("span");
    label.className = "mx-slot-name";
    if (name) {
      label.textContent = name;
    } else {
      label.classList.add("is-placeholder");
      label.textContent = "מלווה " + ord;
    }
    btn.appendChild(label);
    // A free-text external name gets a distinct "מתנדב" badge so it stands out from
    // registered trainees on the monthly board.
    if (external) {
      var badge = document.createElement("span");
      badge.className = "mx-ext-badge";
      badge.textContent = "מתנדב";
      badge.title = "שם מתנדב — אינו משתמש רשום במערכת";
      btn.appendChild(badge);
    }
    (function (b) {
      b.addEventListener("click", function () { openMatrixPicker(b, iso, station, slotKey); });
    })(btn);
    slot.appendChild(btn);

    if (name) {
      var clear = document.createElement("button");
      clear.type = "button";
      clear.className = "mx-slot-clear";
      clear.setAttribute("aria-label", "הסרת " + name + " מהמשמרת");
      clear.title = "הסרה מהירה";
      clear.textContent = "×";
      clear.addEventListener("click", function (e) {
        e.stopPropagation();
        matrixAssign(iso, station, slotKey, "");
      });
      slot.appendChild(clear);
    }
    return slot;
  }

  // Place (or, with an empty name, clear) one intern slot. Optimistically updates
  // the cell and cache, then persists the whole station row via the shared PUT so
  // other slots survive and the change cascades into the trainee's tracking views.
  function matrixAssign(iso, station, slotKey, name) {
    if (!isAdmin() || !state.matrixEditMode) return;
    var clean = (name || "").trim();
    var prev = matrixCellData(iso, station.id);
    // Normalized snapshot of the station BEFORE this change, so the global undo
    // can restore the exact prior state through the same schedules PUT.
    var prevSnap = {
      driver: prev.driver || "",
      medic: prev.medic || "",
      intern1: prev.intern1 || "",
      intern2: prev.intern2 || "",
      note: prev.note || "",
      noFormIntern1: !!prev.noFormIntern1,
      noFormIntern2: !!prev.noFormIntern2
    };
    var entry = {
      driver: prev.driver || "",
      medic: prev.medic || "",
      intern1: prev.intern1 || "",
      intern2: prev.intern2 || "",
      note: prev.note || "",
      noFormIntern1: !!prev.noFormIntern1,
      noFormIntern2: !!prev.noFormIntern2
    };
    entry[slotKey] = clean;

    (cache.matrix[iso] || (cache.matrix[iso] = {}))[String(station.id)] = entry;
    var td = byId(matrixCellId(iso, station.id));
    if (td) fillMatrixCell(td, iso, station);

    var shifts = {}; shifts[station.id] = entry;
    api("PUT", "schedules/" + iso, { shifts: shifts }).then(function () {
      toast(clean ? ("שובץ/ה " + clean + " בהצלחה") : "השיבוץ הוסר", true);
      var revert = {}; revert[station.id] = prevSnap;
      pushUndo({
        source: "matrix", iso: iso, stationId: station.id, station: station,
        prev: prevSnap, revertShifts: revert,
        desc: (clean ? ("שיבוץ " + clean) : "הסרת שיבוץ") + " · " + station.name
      });
      refreshMatrixCounts(iso);
    }).catch(function () {
      toast("השיבוץ נכשל. נסו שוב", false);
      loadMatrix(); // resync from the server when the save fails
    });
  }

  // Admin (monthly grid): hide one station/shift on one date only. This reuses
  // the day-scoped hidden-shift backend route so month templates remain unchanged.
  function matrixHideShift(iso, station, data) {
    if (!isAdmin() || !state.matrixEditMode) return;
    var hasPeople = !!(
      (data && (data.driver || data.medic || data.intern1 || data.intern2)) ||
      (data && Array.isArray(data.trainees) && data.trainees.length)
    );
    var msg = hasPeople
      ? "משמרת זו כבר מכילה שיבוצים. האם אתה בטוח שברצונך למחוק אותה ואת כל השיבוצים בתוכה?"
      : "האם להסיר את המשמרת “" + station.name + " - " + shiftLabel(station.shift) + "” מיום זה?";
    if (!window.confirm(msg)) return;

    api("PUT", "schedules/" + iso + "/hidden/" + station.id).then(function () {
      var list = cache.matrixHidden[iso] || [];
      if (list.indexOf(station.id) === -1) list = list.concat([station.id]);
      cache.matrixHidden[iso] = list;
      if (cache.matrix[iso]) delete cache.matrix[iso][String(station.id)];

      var td = byId(matrixCellId(iso, station.id));
      if (td) fillMatrixCell(td, iso, station);

      if (cache.day && cache.day.iso === iso) {
        cache.day.hidden = (cache.day.hidden || []);
        if (cache.day.hidden.indexOf(station.id) === -1) cache.day.hidden.push(station.id);
        if (cache.day.shifts) delete cache.day.shifts[station.id];
        if (state.selectedDate === iso && el.dayDetail && !el.dayDetail.hidden) renderDayDetail(iso);
      }

      toast("המשמרת הוסרה מיום זה", true);
      refreshShiftCounts();
      loadMonth();
    }).catch(function () {
      toast("הסרת המשמרת נכשלה", false);
    });
  }

  // Toggle one escort's "no form required" flag straight from the matrix picker.
  // Persists the whole station row (like matrixAssign) so the other slots and the
  // sibling escort's flag survive, then keeps the cached entry in sync.
  function matrixSetNoForm(iso, station, slotKey, checked) {
    if (!isAdmin()) return;
    var prev = matrixCellData(iso, station.id);
    var entry = {
      driver: prev.driver || "",
      medic: prev.medic || "",
      intern1: prev.intern1 || "",
      intern2: prev.intern2 || "",
      note: prev.note || "",
      noFormIntern1: !!prev.noFormIntern1,
      noFormIntern2: !!prev.noFormIntern2
    };
    entry[slotKey === "intern1" ? "noFormIntern1" : "noFormIntern2"] = !!checked;

    (cache.matrix[iso] || (cache.matrix[iso] = {}))[String(station.id)] = entry;

    var shifts = {}; shifts[station.id] = entry;
    api("PUT", "schedules/" + iso, { shifts: shifts }).then(function () {
      toast(checked ? "המלווה סומן/ה כלא נדרש/ת לטופס" : "בוטל הסימון 'ללא טופס'", true);
    }).catch(function () {
      toast("השמירה נכשלה. נסו שוב", false);
      loadMatrix(); // resync from the server when the save fails
    });
  }

  // Re-pull the per-trainee WEEK counts for the affected day so the weekly quota
  // pills in the picker stay live.
  function refreshMatrixCounts(iso) {
    return refreshWeekCounts(iso || state.selectedDate || todayIso());
  }

  // The day's submitted availability, fetched once per date and memoized so the
  // picker can rank trainees by their preference for that shift.
  function loadMatrixDayAvail(iso) {
    if (cache.matrixAvail[iso]) return Promise.resolve(cache.matrixAvail[iso]);
    return api("GET", "availability/" + iso).then(function (d) {
      cache.matrixAvail[iso] = (d && d.entries) || [];
      return cache.matrixAvail[iso];
    }).catch(function () {
      cache.matrixAvail[iso] = [];
      return [];
    });
  }

  function matrixDateLabel(iso) {
    var p = iso.split("-");
    return pad(+p[2]) + "/" + pad(+p[1]) + "/" + p[0];
  }

  // Open the inline intern picker anchored to a cell slot. Reuses the day view's
  // floating-popover plumbing (state.assign / positionAssignPop / closeAssignPicker)
  // since only one picker is ever open at a time.
  function openMatrixPicker(btn, iso, station, slotKey) {
    if (!isAdmin() || !state.matrixEditMode) return;
    var field = "mx_" + iso + "_" + station.id + "_" + slotKey;
    var wasOpen = state.assign && state.assign.field === field;
    closeAssignPicker();
    if (wasOpen) return; // second click on the same slot toggles it closed

    var pop = buildMatrixPop(iso, station, slotKey);
    document.body.appendChild(pop);
    positionAssignPop(pop, btn);

    var onDoc = function (e) {
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      closeAssignPicker();
    };
    var onScroll = function () { positionAssignPop(pop, btn); };
    document.addEventListener("click", onDoc, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    state.assign = { field: field, pop: pop, onDoc: onDoc, onScroll: onScroll };

    // Rank by submitted availability and show live weekly quota counts once they
    // arrive; swap the body in place so the popover and its position stay put.
    Promise.all([loadMatrixDayAvail(iso), refreshWeekCounts(iso)]).then(function () {
      if (!state.assign || state.assign.field !== field) return; // closed / moved on
      var old = pop.querySelector(".assign-pop-body");
      if (old) pop.replaceChild(buildMatrixBody(iso, station, slotKey), old);
      positionAssignPop(pop, btn);
    });
  }

  function buildMatrixPop(iso, station, slotKey) {
    var pop = document.createElement("div");
    pop.className = "assign-pop matrix-pop";

    var head = document.createElement("div");
    head.className = "assign-pop-head";
    var titles = document.createElement("div");
    titles.className = "assign-pop-titles";
    var title = document.createElement("span");
    title.className = "assign-pop-title";
    title.innerHTML = '<span class="shift-band ' + station.shift + '"></span>';
    var ord = slotKey === "intern1" ? "א׳" : "ב׳";
    title.appendChild(document.createTextNode("שיבוץ מלווה " + ord + " · משמרת " + shiftLabel(station.shift)));
    var sub = document.createElement("span");
    sub.className = "assign-pop-sub";
    sub.textContent = station.name + " · " + matrixDateLabel(iso); // user data → textContent
    titles.appendChild(title);
    titles.appendChild(sub);

    var x = document.createElement("button");
    x.type = "button";
    x.className = "assign-pop-x";
    x.setAttribute("aria-label", "סגירה");
    x.textContent = "×";
    x.addEventListener("click", closeAssignPicker);

    head.appendChild(titles);
    head.appendChild(x);
    pop.appendChild(head);

    // Rapid search across all trainees — lives outside the body so re-rendering
    // the list on each keystroke never steals focus from the input.
    var searchWrap = document.createElement("div");
    searchWrap.className = "matrix-pop-search";
    var search = document.createElement("input");
    search.type = "search";
    search.className = "matrix-pop-search-input";
    search.placeholder = "חיפוש חניך/ה או הקלדת שם מתנדב…";
    search.setAttribute("autocomplete", "off");
    search.addEventListener("input", function () {
      var body = pop.querySelector(".assign-pop-body");
      if (body) pop.replaceChild(buildMatrixBody(iso, station, slotKey, search.value), body);
    });
    searchWrap.appendChild(search);
    pop.appendChild(searchWrap);

    pop.appendChild(buildMatrixBody(iso, station, slotKey));
    return pop;
  }

  // The trainee list, grouped by submitted preference (prefer → avoid → none →
  // cannot) and filtered by the search query, with a quick remove at the top when
  // the slot already holds someone.
  function buildMatrixBody(iso, station, slotKey, query) {
    var body = document.createElement("div");
    body.className = "assign-pop-body";
    var q = (query || "").trim().toLowerCase();

    var data = matrixCellData(iso, station.id);
    var current = (data[slotKey] || "").trim();

    if (current) {
      var clearItem = document.createElement("button");
      clearItem.type = "button";
      clearItem.className = "assign-item matrix-clear-item";
      var cnm = document.createElement("span");
      cnm.className = "assign-item-name";
      cnm.textContent = "הסרת " + current;
      clearItem.appendChild(cnm);
      var ctag = document.createElement("span");
      ctag.className = "assign-item-tag matrix-clear-tag";
      ctag.textContent = "הסרה";
      clearItem.appendChild(ctag);
      clearItem.addEventListener("click", function () {
        closeAssignPicker();
        matrixAssign(iso, station, slotKey, "");
      });
      body.appendChild(clearItem);
    }

    // Per-escort "no form required" toggle, editable right inside the picker: the
    // current slotKey is מלווה א׳ or מלווה ב׳, so this controls only that escort's
    // flag. Marking it excludes that escort from the published form email.
    // Confidential — shown only to admins/schedulers (see canSeeNoForm).
    if (canSeeNoForm()) {
      var nfWrap = document.createElement("label");
      nfWrap.className = "noform-toggle matrix-noform-toggle";
      nfWrap.title = "סמנו עבור מלווה שאינו חניך (למשל מתנדב/ת) כדי לדלג על טופס החניכה";
      var nfFlag = slotKey === "intern1" ? "noFormIntern1" : "noFormIntern2";
      var nfCb = document.createElement("input");
      nfCb.type = "checkbox";
      nfCb.checked = !!(data && data[nfFlag]);
      nfCb.addEventListener("change", function () {
        matrixSetNoForm(iso, station, slotKey, nfCb.checked);
      });
      var nfTxt = document.createElement("span");
      nfTxt.textContent = "מלווה זה/זו אינו/ה נדרש/ת לטופס (מתנדב/ת)";
      nfWrap.appendChild(nfCb);
      nfWrap.appendChild(nfTxt);
      body.appendChild(nfWrap);
    }

    // Creatable option: when the search box holds text that matches no registered
    // trainee, offer to schedule it verbatim as an external name. Lets an admin
    // place a guest / one-off cover who has no account, saved into the same slot.
    var raw = (query || "").trim();
    if (raw && raw.toLowerCase() !== current.toLowerCase()) {
      var exact = approvedTrainees().some(function (u) {
        return String(u.name).trim().toLowerCase() === raw.toLowerCase();
      });
      if (!exact) {
        var createItem = document.createElement("button");
        createItem.type = "button";
        createItem.className = "assign-item matrix-create-item";
        var cn = document.createElement("span");
        cn.className = "assign-item-name";
        cn.textContent = "שיבוץ שם מתנדב: “" + raw + "”";
        createItem.appendChild(cn);
        var ct = document.createElement("span");
        ct.className = "assign-item-tag matrix-ext-tag";
        ct.textContent = "מתנדב";
        createItem.appendChild(ct);
        createItem.addEventListener("click", function () {
          closeAssignPicker();
          matrixAssign(iso, station, slotKey, raw);
        });
        body.appendChild(createItem);
      }
    }

    // Availability for this date + this station's shift, keyed by lowercased email.
    var availMap = {};
    (cache.matrixAvail[iso] || []).forEach(function (e) {
      if (e.shiftType === station.shift) availMap[(e.email || "").toLowerCase()] = e.preference;
    });

    var groups = { prefer: [], avoid: [], none: [], cannot: [] };
    approvedTrainees().forEach(function (u) {
      if (q && String(u.name).toLowerCase().indexOf(q) === -1) return;
      var pref = availMap[(u.email || "").toLowerCase()];
      if (pref === "prefer" || pref === "avoid" || pref === "cannot") groups[pref].push(u);
      else groups.none.push(u);
    });
    Object.keys(groups).forEach(function (k) {
      groups[k].sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "he"); });
    });

    // Names already on this station today, to flag a would-be double-booking.
    var assigned = {};
    ["driver", "medic", "intern1", "intern2"].forEach(function (k) {
      var v = (data[k] || "").trim(); if (v) assigned[v] = true;
    });

    var total = 0;
    ASSIGN_GROUPS.forEach(function (g) {
      var members = groups[g.key];
      if (!members || !members.length) return;
      total += members.length;

      var section = document.createElement("div");
      section.className = "assign-group";
      var gt = document.createElement("div");
      gt.className = "assign-group-title " + g.cls;
      gt.textContent = g.title + " (" + members.length + ")";
      section.appendChild(gt);

      members.forEach(function (u) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "assign-item " + g.cls;
        if (u.name === current) item.classList.add("is-current");

        var nm = document.createElement("span");
        nm.className = "assign-item-name";
        nm.textContent = u.name; // user data → textContent
        item.appendChild(nm);
        item.appendChild(buildAssignQuota(u));

        if (assigned[u.name] && u.name !== current) {
          var busy = document.createElement("span");
          busy.className = "assign-item-busy";
          busy.textContent = "כבר משובץ/ת";
          item.appendChild(busy);
        }
        if (g.tag) {
          var tg = document.createElement("span");
          tg.className = "assign-item-tag";
          tg.textContent = g.tag;
          item.appendChild(tg);
        }

        if (g.key === "cannot") {
          item.disabled = true;
          item.title = "החניך/ה סימן/ה שאינו/ה יכול/ה לעבוד במשמרת זו";
        } else {
          (function (name) {
            item.addEventListener("click", function () {
              closeAssignPicker();
              matrixAssign(iso, station, slotKey, name);
            });
          })(u.name);
        }
        section.appendChild(item);
      });
      body.appendChild(section);
    });

    if (total === 0) {
      var empty = document.createElement("p");
      empty.className = "assign-empty";
      empty.textContent = q ? "לא נמצא חניך/ה תואם/ת." : "אין חניכים מאושרים לשיבוץ.";
      body.appendChild(empty);
    }
    return body;
  }

  /* ---------------- Placement / regional deployment notes ----------------
     A dedicated tab for "where are you deployed this week" notes. Schedulers get an
     admin form to attach a spatial note to a trainee for a chosen week; trainees see
     a clean read-only alert list of the notes addressed to them. Fully isolated from
     the rest of the app — its own load/render/save helpers, its own endpoint. */
  function placementIsStaff() { return canEditSchedule() || canManageRoles(); }

  // Human-friendly "יום שלישי, 07/07 · ערב" label for a targeted note's day + shift.
  function placementDateLabel(iso, shiftId) {
    if (!iso) return "";
    var parts = String(iso).split("-");
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    var label = "יום " + HE_WEEKDAYS[d.getDay()] + ", " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
    if (shiftId) label += " · משמרת " + shiftLabel(shiftId);
    return label;
  }

  // Resolve a user id to a display name (staff have the full roster cached; a
  // trainee viewing their own note falls back to their own name).
  function placementUserName(userId) {
    var u = (cache.users || []).filter(function (x) { return x.id === userId; })[0];
    if (u) return u.name;
    if (state.user && state.user.id === userId) return state.user.name;
    return "חניך/ה #" + userId;
  }

  // Build the "משוב על דיווח טפסים" indicator for a note. The server cross-references
  // the note's (trainee, day) against the schedule + form completions and returns a
  // { code, label }; here we just paint it in the right colour. Returns null when the
  // note carries no status (older cached payloads).
  function buildPlacementFormBadge(fs) {
    if (!fs || !fs.label) return null;
    var badge = document.createElement("span");
    var code = fs.code || "none";
    badge.className = "placement-form-badge is-" + code;
    var dot = document.createElement("span");
    dot.className = "placement-form-dot";
    badge.appendChild(dot);
    var txt = document.createElement("span");
    txt.textContent = fs.label;
    badge.appendChild(txt);
    badge.title = "סטטוס משוב על דיווח טפסים למשמרת זו";
    return badge;
  }

  function loadPlacementNotes() {
    renderPlacementAdminForm();
    if (el.placementList) el.placementList.innerHTML = '<p class="swap-empty">טוען…</p>';
    return api("GET", "placement-notes").then(function (d) {
      cache.placementNotes = (d && d.notes) || [];
      renderPlacementNotes();
      // Keep an open day-detail banner in sync with the latest notes.
      if (state.selectedDate && el.dayDetail && !el.dayDetail.hidden) renderDayDetail(state.selectedDate);
    }).catch(function () {
      cache.placementNotes = [];
      renderPlacementNotes();
    });
  }

  // Reveal + populate the scheduler form only for staff; trainees never see it.
  function renderPlacementAdminForm() {
    if (!el.placementForm) return;
    var staff = placementIsStaff();
    el.placementForm.hidden = !staff;
    if (!staff) return;
    if (el.placementUser) {
      var prev = el.placementUser.value;
      el.placementUser.innerHTML = "";
      var people = (cache.users || []).slice().sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), "he");
      });
      people.forEach(function (u) {
        var opt = document.createElement("option");
        opt.value = String(u.id);
        opt.textContent = u.name;
        el.placementUser.appendChild(opt);
      });
      if (prev) el.placementUser.value = prev;
    }
    if (el.placementDate && !el.placementDate.value) {
      el.placementDate.value = isoOf(upcomingWeekStart());
    }
  }

  function renderPlacementNotes() {
    if (!el.placementList) return;
    el.placementList.innerHTML = "";
    var staff = placementIsStaff();
    var notes = (cache.placementNotes || []).slice();
    if (!notes.length) {
      var empty = document.createElement("p");
      empty.className = "swap-empty";
      empty.textContent = staff
        ? "לא הוגדרו הערות שיבוץ. השתמשו בטופס שלמעלה כדי לשייך הערה לחניך/ה."
        : "אין כרגע הערות שיבוץ מרחביות עבורך.";
      el.placementList.appendChild(empty);
      return;
    }
    notes.forEach(function (n) {
      el.placementList.appendChild(buildPlacementCard(n, staff));
    });
  }

  function buildPlacementCard(n, staff) {
    var card = document.createElement("div");
    card.className = "placement-card";

    var head = document.createElement("div");
    head.className = "placement-card-head";
    var who = document.createElement("span");
    who.className = "placement-who";
    who.textContent = staff ? placementUserName(n.userId) : "שיבוץ אישי";
    var wk = document.createElement("span");
    wk.className = "placement-week";
    wk.textContent = placementDateLabel(n.date, n.shiftId);
    head.appendChild(who);
    head.appendChild(wk);
    card.appendChild(head);

    var body = document.createElement("p");
    body.className = "placement-text";
    body.textContent = n.noteText;
    card.appendChild(body);

    // Compliance / evaluation-form status for this deployment. Trainees see whether
    // they still owe a form; staff use it to track whether the trainee actually
    // reported their external shift.
    var badge = buildPlacementFormBadge(n.formStatus);
    if (badge) {
      var statusRow = document.createElement("div");
      statusRow.className = "placement-form-row";
      var label = document.createElement("span");
      label.className = "placement-form-label";
      label.textContent = "משוב על דיווח טפסים:";
      statusRow.appendChild(label);
      statusRow.appendChild(badge);
      card.appendChild(statusRow);
    }

    if (staff) {
      var actions = document.createElement("div");
      actions.className = "placement-actions";
      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm";
      del.textContent = "מחיקה";
      del.addEventListener("click", function () { deletePlacementNote(n.id); });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn-ghost btn-sm";
      edit.textContent = "עריכה";
      edit.addEventListener("click", function () {
        if (el.placementUser) el.placementUser.value = String(n.userId);
        if (el.placementDate) el.placementDate.value = n.date || "";
        if (el.placementShift) el.placementShift.value = n.shiftId || "";
        if (el.placementNote) el.placementNote.value = n.noteText;
        if (el.placementNote) el.placementNote.focus();
      });
      actions.appendChild(edit);
      actions.appendChild(del);
      card.appendChild(actions);
    }
    return card;
  }

  function savePlacementNote(e) {
    e.preventDefault();
    if (!placementIsStaff()) return;
    var userId = Number(el.placementUser && el.placementUser.value);
    var date = el.placementDate ? el.placementDate.value : "";
    var shiftId = el.placementShift ? el.placementShift.value : "";
    var noteText = el.placementNote ? el.placementNote.value.trim() : "";
    if (!userId) { toast("יש לבחור חניך/ה", false); return; }
    if (!date) { toast("יש לבחור תאריך", false); return; }
    if (!noteText) { toast("יש לכתוב הערת שיבוץ", false); return; }
    api("POST", "placement-notes", { userId: userId, date: date, shiftId: shiftId, noteText: noteText })
      .then(function () {
        if (el.placementNote) el.placementNote.value = "";
        toast("הערת השיבוץ נשמרה", true);
        loadPlacementNotes();
      })
      .catch(function () { toast("שמירת ההערה נכשלה", false); });
  }

  function deletePlacementNote(id) {
    api("DELETE", "placement-notes/" + id)
      .then(function () { toast("ההערה נמחקה", true); loadPlacementNotes(); })
      .catch(function () { toast("מחיקת ההערה נכשלה", false); });
  }

  // Inline banner for the day-detail view listing every placement note targeted at
  // this exact date. Trainees only ever have their own notes cached, so they see
  // just their deployment; staff see all trainees deployed elsewhere on the day.
  function buildPlacementDayBanner(iso) {
    var notes = (cache.placementNotes || []).filter(function (n) { return n.date === iso; });
    if (!notes.length) return null;
    var staff = placementIsStaff();
    var box = document.createElement("div");
    box.className = "placement-day-banner";
    var title = document.createElement("div");
    title.className = "placement-day-title";
    title.textContent = staff ? "הערות שיבוץ ליום זה" : "הערת שיבוץ עבורך";
    box.appendChild(title);
    notes.forEach(function (n) {
      var row = document.createElement("p");
      row.className = "placement-day-note";
      var prefix = "";
      if (staff) prefix = placementUserName(n.userId) + ": ";
      else if (n.shiftId) prefix = "משמרת " + shiftLabel(n.shiftId) + ": ";
      row.textContent = prefix + n.noteText;
      var badge = buildPlacementFormBadge(n.formStatus);
      if (badge) row.appendChild(badge);
      box.appendChild(row);
    });
    return box;
  }

  /* ---- Trainee Schedule View ---- */
  function loadTraineesList() {
    if (!isAdmin()) return Promise.resolve();
    return api("GET", "trainees")
      .then(function (data) {
        cache.trainees = data.trainees || [];
        renderTraineesDropdown();
        renderTraineeViewEditControls();
      })
      .catch(function () {
        cache.trainees = [];
        renderTraineesDropdown();
        renderTraineeViewEditControls();
      });
  }

  function renderTraineesDropdown() {
    if (!el.traineeViewSelect) return;
    var selectedValue = el.traineeViewSelect.value;
    while (el.traineeViewSelect.firstChild) el.traineeViewSelect.removeChild(el.traineeViewSelect.firstChild);
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- בחר/י חניך/ה --";
    el.traineeViewSelect.appendChild(placeholder);

    if (cache.trainees && cache.trainees.length) {
      cache.trainees.forEach(function (t) {
        var opt = document.createElement("option");
        opt.value = String(t.id || "");
        opt.textContent = t.name || "";
        if (t.email) opt.setAttribute("data-email", t.email);
        el.traineeViewSelect.appendChild(opt);
      });
    }

    if (selectedValue) el.traineeViewSelect.value = selectedValue;
  }

  function renderTraineeViewEditControls() {
    if (el.traineeViewEditBanner) el.traineeViewEditBanner.hidden = !(isAdmin() && state.traineeViewEditMode);
    if (!el.traineeViewEditToggle) return;
    el.traineeViewEditToggle.innerHTML = "";
    if (!isAdmin()) return;
    el.traineeViewEditToggle.appendChild(buildEditPencil(!!state.traineeViewEditMode, function () {
      toggleTraineeViewEditMode();
    }));
  }

  function toggleTraineeViewEditMode(force) {
    var next = typeof force === "boolean" ? force : !state.traineeViewEditMode;
    state.traineeViewEditMode = next;
    if (!next) closeTraineeAssignPicker();
    renderTraineeViewEditControls();
    renderTraineeScheduleGrid();
  }

  function getSelectedTraineeInfo() {
    if (!el.traineeViewSelect) return null;
    var value = String(el.traineeViewSelect.value || "");
    if (!value) return null;
    var opt = getTraineeOption(value);
    if (!opt) return null;
    return {
      id: Number(value),
      name: opt.textContent || "",
      email: String(opt.getAttribute("data-email") || ""),
    };
  }

  function getSelectedTraineeName() {
    var selected = getSelectedTraineeInfo();
    return selected ? selected.name : "";
  }

  function getStationNameById(stationId) {
    var id = Number(stationId);
    var stations = cache.stations || [];
    for (var i = 0; i < stations.length; i++) {
      if (Number(stations[i].id) === id) return stations[i].name || "";
    }
    return String(stationId || "");
  }

  function closeTraineeAssignPicker() {
    var a = state.traineeAssign;
    if (!a) return;
    document.removeEventListener("click", a.onDoc, true);
    window.removeEventListener("scroll", a.onScroll, true);
    window.removeEventListener("resize", a.onScroll, true);
    if (a.pop && a.pop.parentNode) a.pop.parentNode.removeChild(a.pop);
    state.traineeAssign = null;
  }

  function loadTraineeViewDay(iso) {
    return Promise.all([
      api("GET", "schedules/" + iso).catch(function () {
        return { date: iso, shifts: {}, hidden: [], custom: [] };
      }),
      (cache.stations && cache.stations.length ? Promise.resolve() : refreshStations().catch(function () { return []; })),
    ]).then(function (res) {
      return res[0];
    });
  }

  function collectTraineeViewOpenSlots(dayData, shiftType) {
    var slots = [];
    var shifts = (dayData && dayData.shifts) || {};
    var stations = (cache.stations || []).filter(function (st) { return String(st.shift || "") === shiftType; });

    stations.forEach(function (station) {
      var row = shifts[String(station.id)] || {};
      if (String(row.taskType || "shift") !== "shift") return;
      ["intern1", "intern2"].forEach(function (slotKey) {
        var currentName = String(row[slotKey] || "").trim();
        slots.push({
          stationId: Number(station.id),
          stationName: station.name || getStationNameById(station.id),
          slotKey: slotKey,
          slotLabel: slotKey === "intern1" ? "תקן חניך 1" : "תקן חניך 2",
          isCustom: false,
          isOccupied: !!currentName,
          currentName: currentName,
          row: row,
        });
      });
    });

    ((dayData && dayData.custom) || []).forEach(function (row) {
      if (String(row.taskType || "shift") !== "shift") return;
      if (String(row.shift || "") !== shiftType) return;
      ["intern1", "intern2"].forEach(function (slotKey) {
        var currentName = String(row[slotKey] || "").trim();
        slots.push({
          stationId: Number(row.id),
          stationName: row.name || "",
          slotKey: slotKey,
          slotLabel: slotKey === "intern1" ? "תקן חניך 1" : "תקן חניך 2",
          isCustom: true,
          isOccupied: !!currentName,
          currentName: currentName,
          row: row,
        });
      });
    });

    if (!slots.length && stations.length === 0) {
      ["intern1", "intern2"].forEach(function (slotKey) {
        slots.push({
          stationId: 0,
          stationName: shiftLabel(shiftType),
          slotKey: slotKey,
          slotLabel: slotKey === "intern1" ? "תקן חניך 1" : "תקן חניך 2",
          isCustom: false,
          isFallback: true,
          isOccupied: false,
          currentName: "",
          row: {},
        });
      });
    }

    return slots;
  }

  function buildTraineeAssignBody(iso, shiftType, selected) {
    var body = document.createElement("div");
    body.className = "assign-pop-body";

    var selectedName = selected ? selected.name : "";
    var hint = document.createElement("div");
    hint.className = "assign-group-title";
    hint.textContent = selectedName ? ("בחרו תקן פנוי לשיבוץ " + selectedName + ".") : "בחרו חניך/ה קודם.";
    body.appendChild(hint);

    if (!selectedName) return body;

    var slots = collectTraineeViewOpenSlots(state.traineeAssign && state.traineeAssign.dayData, shiftType);
    if (!slots.length) {
      var empty = document.createElement("p");
      empty.className = "matrix-empty";
      empty.textContent = "לא נטענו תקנים למשמרת זו.";
      body.appendChild(empty);
      return body;
    }

    slots.forEach(function (slot) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "assign-item";
      item.textContent = slot.stationName + " · " + slot.slotLabel + (slot.isOccupied ? " (תפוס: " + slot.currentName + ")" : "");
      if (slot.isFallback) {
        item.disabled = true;
        item.title = "לא נטענו עדיין התקנים של המשמרת";
      }
      item.addEventListener("click", function () {
        assignTraineeToOpenSlot(iso, slot, selected);
      });
      body.appendChild(item);
    });

    return body;
  }

  function openTraineeAssignPicker(btn, iso, shiftType) {
    if (!isAdmin() || !state.traineeViewEditMode) return;
    var selected = getSelectedTraineeInfo();
    if (!selected) {
      toast("יש לבחור חניך/ה", false);
      return;
    }

    var field = iso + "|" + shiftType;
    var wasOpen = state.traineeAssign && state.traineeAssign.field === field;
    closeTraineeAssignPicker();
    if (wasOpen) return;

    var pop = document.createElement("div");
    pop.className = "assign-pop";

    var head = document.createElement("div");
    head.className = "assign-pop-head";
    var titles = document.createElement("div");
    titles.className = "assign-pop-titles";
    var title = document.createElement("span");
    title.className = "assign-pop-title";
    title.innerHTML = '<span class="shift-band ' + shiftType + '"></span>';
    title.appendChild(document.createTextNode("שיבוץ " + selected.name + " · משמרת " + shiftLabel(shiftType)));
    var sub = document.createElement("span");
    sub.className = "assign-pop-sub";
    sub.textContent = "בחרו תקן פנוי לשיבוץ החניך/ה";
    titles.appendChild(title);
    titles.appendChild(sub);

    var x = document.createElement("button");
    x.type = "button";
    x.className = "assign-pop-x";
    x.setAttribute("aria-label", "סגירה");
    x.textContent = "×";
    x.addEventListener("click", closeTraineeAssignPicker);

    head.appendChild(titles);
    head.appendChild(x);
    pop.appendChild(head);

    var loading = document.createElement("div");
    loading.className = "assign-pop-body";
    loading.textContent = "טוען תקנים פנויים…";
    pop.appendChild(loading);

    document.body.appendChild(pop);
    positionAssignPop(pop, btn);

    var onDoc = function (e) {
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      closeTraineeAssignPicker();
    };
    var onScroll = function () { positionAssignPop(pop, btn); };
    document.addEventListener("click", onDoc, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    state.traineeAssign = { field: field, pop: pop, onDoc: onDoc, onScroll: onScroll, iso: iso, shiftType: shiftType, selected: selected, dayData: null, anchor: btn };

    loadTraineeViewDay(iso).then(function (dayData) {
      if (!state.traineeAssign || state.traineeAssign.field !== field) return;
      state.traineeAssign.dayData = dayData;
      var old = pop.querySelector(".assign-pop-body");
      var next = buildTraineeAssignBody(iso, shiftType, selected);
      if (old) pop.replaceChild(next, old); else pop.appendChild(next);
      positionAssignPop(pop, btn);
    });
  }

  function assignTraineeToOpenSlot(iso, slot, trainee) {
    if (!trainee || !trainee.name) return;
    var dayData = (state.traineeAssign && state.traineeAssign.dayData) || null;
    if (!dayData) return;

    var payload = { shifts: {}, custom: {} };
    var entry;
    if (slot.isCustom) {
      var customRow = null;
      (dayData.custom || []).forEach(function (row) {
        if (Number(row.id) === Number(slot.stationId)) customRow = row;
      });
      if (!customRow) return;
      entry = {
        driver: customRow.driver || "",
        medic: customRow.medic || "",
        intern1: customRow.intern1 || "",
        intern2: customRow.intern2 || "",
        note: customRow.note || "",
        taskType: customRow.taskType || "shift",
        trainees: Array.isArray(customRow.trainees) ? customRow.trainees.slice() : [],
      };
      entry[slot.slotKey] = trainee.name;
      payload.custom[String(slot.stationId)] = entry;
    } else {
      var row = (dayData.shifts || {})[String(slot.stationId)];
      if (!row) return;
      entry = {
        driver: row.driver || "",
        medic: row.medic || "",
        intern1: row.intern1 || "",
        intern2: row.intern2 || "",
        note: row.note || "",
        taskType: row.taskType || "shift",
        trainees: Array.isArray(row.trainees) ? row.trainees.slice() : [],
      };
      entry[slot.slotKey] = trainee.name;
      payload.shifts[String(slot.stationId)] = entry;
    }

    api("PUT", "schedules/" + iso, payload).then(function () {
      if (state.traineeAssign && state.traineeAssign.dayData && state.traineeAssign.dayData.date === iso) {
        var day = state.traineeAssign.dayData;
        if (slot.isCustom) {
          (day.custom || []).forEach(function (row) {
            if (Number(row.id) !== Number(slot.stationId)) return;
            row[slot.slotKey] = trainee.name;
          });
        } else {
          var row = (day.shifts || {})[String(slot.stationId)];
          if (row) row[slot.slotKey] = trainee.name;
        }
      }
      closeTraineeAssignPicker();
      toast("השיבוץ נשמר", true);
      loadTraineeSchedule(trainee.id);
    }).catch(function () {
      toast("שמירת השיבוץ נכשלה", false);
    });
  }

  function getTraineeOption(traineeId) {
    if (!el.traineeViewSelect) return null;
    var value = String(traineeId || "");
    var options = el.traineeViewSelect.options || [];
    for (var i = 0; i < options.length; i++) {
      if (String(options[i].value || "") === value) return options[i];
    }
    return null;
  }

  function traineeConstraintLabel(preference) {
    if (preference === "prefer") return "מעדיף להשתבץ";
    if (preference === "avoid") return "מעדיף שלא";
    if (preference === "cannot") return "לא זמין";
    return "";
  }

  function formatTraineeViewDate(year, monthIndex, day) {
    return pad(day) + "/" + pad(monthIndex + 1) + "/" + year;
  }

  function buildMonthDays(monthIso) {
    var parts = (monthIso || "").split("-");
    if (parts.length !== 2) return [];
    var year = Number(parts[0]);
    var monthIndex = Number(parts[1]) - 1;
    if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) return [];
    var daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    var rows = [];
    for (var day = 1; day <= daysInMonth; day++) {
      rows.push({
        date: year + "-" + pad(monthIndex + 1) + "-" + pad(day),
        year: year,
        monthIndex: monthIndex,
        day: day,
      });
    }
    return rows;
  }

  function onTraineeViewSelect(e) {
    var traineeId = Number(el.traineeViewSelect ? el.traineeViewSelect.value : 0);
    if (!traineeId) {
      if (el.traineeScheduleTable) el.traineeScheduleTable.hidden = true;
      if (el.traineeScheduleEmpty) el.traineeScheduleEmpty.hidden = false;
      return;
    }
    loadTraineeSchedule(traineeId);
  }

  function loadTraineeSchedule(traineeId) {
    var now = new Date();
    var monthStr = isoOf(now).substring(0, 7);
    var traineeOpt = getTraineeOption(traineeId);
    var traineeEmail = traineeOpt ? String(traineeOpt.getAttribute("data-email") || "") : "";
    var days = buildMonthDays(monthStr).map(function (day) { return day.date; });
    return Promise.all([
      Promise.all(days.map(function (iso) { return loadTraineeViewDay(iso); })),
      api("GET", "availability?month=" + monthStr).catch(function () { return { entries: [] }; }),
    ]).then(function (results) {
      var liveDays = results[0] || [];
      var availabilityData = results[1] || { entries: [] };
      var entries = Array.isArray(availabilityData.entries) ? availabilityData.entries : [];
      if (traineeEmail) {
        entries = entries.filter(function (entry) {
          return String(entry.email || "").toLowerCase() === traineeEmail.toLowerCase();
        });
      }
      cache.traineeSchedule = {
        month: monthStr,
        traineeId: traineeId,
        traineeName: traineeOpt ? traineeOpt.textContent : "",
        traineeEmail: traineeEmail,
        liveDays: liveDays,
        availabilityEntries: entries,
      };
      renderTraineeScheduleGrid();
    }).catch(function () {
      cache.traineeSchedule = null;
      renderTraineeScheduleGrid();
    });
  }

  function renderTraineeScheduleGrid() {
    if (!el.traineeScheduleTbody) return;
    while (el.traineeScheduleTbody.firstChild) el.traineeScheduleTbody.removeChild(el.traineeScheduleTbody.firstChild);

    var data = cache.traineeSchedule;
    if (!data || !data.month) {
      if (el.traineeScheduleTable) el.traineeScheduleTable.hidden = true;
      if (el.traineeScheduleEmpty) el.traineeScheduleEmpty.hidden = false;
      return;
    }

    var dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
    var prefsByDate = {};
    (data.availabilityEntries || []).forEach(function (entry) {
      if (!prefsByDate[entry.date]) prefsByDate[entry.date] = {};
      prefsByDate[entry.date][entry.shiftType] = entry.preference;
    });
    var liveByDate = {};
    (data.liveDays || []).forEach(function (dayData) {
      if (dayData && dayData.date) liveByDate[dayData.date] = dayData;
    });

    var canEdit = isAdmin() && state.traineeViewEditMode;
    var traineeName = getSelectedTraineeName();

    function slotLabelForKey(slotKey) {
      if (slotKey === "driver") return "נהג";
      if (slotKey === "paramedic") return "פראמדיק";
      if (slotKey === "intern1") return "תקן חניך 1";
      if (slotKey === "intern2") return "תקן חניך 2";
      return slotKey || "משתלם";
    }

    function matchesTraineeName(name) {
      return String(name || "").trim().toLowerCase() === String(traineeName || "").trim().toLowerCase();
    }

    function liveAssignmentsForShift(dayData, shiftType) {
      var hits = [];
      if (!dayData) return hits;
      var shifts = dayData.shifts || {};
      Object.keys(shifts).forEach(function (stationId) {
        var row = shifts[stationId] || {};
        if (String(row.taskType || "shift") !== "shift") return;
        if (String(row.shift || "") !== shiftType) return;
        var stationName = getStationNameById(stationId);
        ["driver", "paramedic", "intern1", "intern2"].forEach(function (slotKey) {
          var slotName = row[slotKey] || "";
          if (!matchesTraineeName(slotName)) return;
          hits.push(stationName + " · " + slotLabelForKey(slotKey));
        });
      });
      ((dayData.custom) || []).forEach(function (row) {
        if (String(row.taskType || "shift") !== "shift") return;
        if (String(row.shift || "") !== shiftType) return;
        ["driver", "paramedic", "intern1", "intern2"].forEach(function (slotKey) {
          var slotName = row[slotKey] || "";
          if (!matchesTraineeName(slotName)) return;
          hits.push((row.name || "") + " · " + slotLabelForKey(slotKey));
        });
        (row.trainees || []).forEach(function (n) {
          if (matchesTraineeName(n)) hits.push((row.name || "") + " · משתלם");
        });
      });
      return hits;
    }

    buildMonthDays(data.month).forEach(function (day) {
      var d = new Date(day.year, day.monthIndex, day.day);
      var dayName = dayNames[d.getDay()] || "";
      var dayData = liveByDate[day.date] || null;
      var liveAssignments = {
        night: liveAssignmentsForShift(dayData, "night"),
        morning: liveAssignmentsForShift(dayData, "morning"),
        evening: liveAssignmentsForShift(dayData, "evening"),
      };

      var tr = document.createElement("tr");
      var tdDate = document.createElement("td");
      tdDate.className = "col-date";
      tdDate.textContent = formatTraineeViewDate(day.year, day.monthIndex, day.day);
      tr.appendChild(tdDate);

      var tdDay = document.createElement("td");
      tdDay.className = "col-weekday";
      tdDay.textContent = dayName;
      tr.appendChild(tdDay);

      ["night", "morning", "evening"].forEach(function (shiftType) {
        var constraint = document.createElement("td");
        constraint.className = "col-constraint col-constraint-" + shiftType;
        constraint.textContent = traineeConstraintLabel((prefsByDate[day.date] || {})[shiftType] || "");
        tr.appendChild(constraint);

        var td = document.createElement("td");
        td.className = "col-shift col-" + shiftType;
        if ((liveAssignments[shiftType] || []).length > 0) {
          td.classList.add("shift-assigned");
          td.textContent = liveAssignments[shiftType].join(" / ");
        } else {
          td.textContent = traineeConstraintLabel((prefsByDate[day.date] || {})[shiftType] || "");
        }
        if (canEdit) {
          td.classList.add("is-editable");
          (function (iso, shiftType, cell) {
            cell.addEventListener("click", function () {
              openTraineeAssignPicker(cell, iso, shiftType);
            });
          })(day.date, shiftType, td);
        }
        tr.appendChild(td);
      });

      el.traineeScheduleTbody.appendChild(tr);
    });

    if (el.traineeScheduleTable) el.traineeScheduleTable.hidden = false;
    if (el.traineeScheduleEmpty) el.traineeScheduleEmpty.hidden = true;
  }

  /* ---------------- Admin analytics dashboard ---------------- */
  function loadDashboard() {
    if (!isAdmin()) return Promise.resolve();
    if (el.dashboardKpis) el.dashboardKpis.innerHTML = '<p class="swap-empty">טוען…</p>';
    return api("GET", "analytics").catch(function () { return null; }).then(function (a) {
      cache.analytics = a;
      renderDashboard();
    });
  }

  function kpiCard(value, label) {
    var card = document.createElement("div");
    card.className = "kpi-card";
    var v = document.createElement("span");
    v.className = "kpi-value";
    v.textContent = value;
    var l = document.createElement("span");
    l.className = "kpi-label";
    l.textContent = label;
    card.appendChild(v);
    card.appendChild(l);
    return card;
  }

  function renderLeaderboard(host, rows, emptyText) {
    if (!host) return;
    host.innerHTML = "";
    if (!rows || !rows.length) {
      var li = document.createElement("li");
      li.className = "leaderboard-empty";
      li.textContent = emptyText;
      host.appendChild(li);
      return;
    }
    rows.forEach(function (r) {
      var li = document.createElement("li");
      var nm = document.createElement("span");
      nm.className = "lb-name";
      nm.textContent = r.name;
      var ct = document.createElement("span");
      ct.className = "lb-count";
      ct.textContent = r.count;
      li.appendChild(nm);
      li.appendChild(ct);
      host.appendChild(li);
    });
  }

  function renderDashboard() {
    var a = cache.analytics;
    if (el.dashboardKpis) {
      el.dashboardKpis.innerHTML = "";
      el.dashboardKpis.appendChild(kpiCard(a ? a.shiftsScheduled : "—", "משמרות שובצו החודש"));
      el.dashboardKpis.appendChild(kpiCard(a ? a.pendingForms : "—", "טפסים שטרם בוצעו"));
    }
    renderLeaderboard(el.dashTopTrainees, a && a.topTrainees, "אין נתונים עדיין.");
    renderLeaderboard(el.dashTopMedics, a && a.topPendingParamedics, "אין טפסים פתוחים.");
  }

  /* ---------------- UI helpers ---------------- */
  function showError(msg) { el.loginError.textContent = msg; el.loginError.hidden = false; }
  function hideError() { el.loginError.hidden = true; }
  function showNotice(msg) { el.loginNotice.textContent = msg; el.loginNotice.hidden = false; }
  function hideNotice() { if (el.loginNotice) el.loginNotice.hidden = true; }
  function showRegError(msg) { el.registerError.textContent = msg; el.registerError.hidden = false; }
  function hideRegError() { if (el.registerError) el.registerError.hidden = true; }
  function showForgotError(msg) { if (el.forgotError) { el.forgotError.textContent = msg; el.forgotError.hidden = false; } }
  function hideForgotError() { if (el.forgotError) el.forgotError.hidden = true; }
  function showForgotNotice(msg) { if (el.forgotNotice) { el.forgotNotice.textContent = msg; el.forgotNotice.hidden = false; } }
  function hideForgotNotice() { if (el.forgotNotice) el.forgotNotice.hidden = true; }
  function showResetError(msg) { if (el.resetError) { el.resetError.textContent = msg; el.resetError.hidden = false; } }
  function hideResetError() { if (el.resetError) el.resetError.hidden = true; }
  function showResetNotice(msg) { if (el.resetNotice) { el.resetNotice.textContent = msg; el.resetNotice.hidden = false; } }
  function hideResetNotice() { if (el.resetNotice) el.resetNotice.hidden = true; }

  var toastTimer = null;
  function toast(msg, ok) {
    el.toast.innerHTML = '<span class="toast-mark">' + (ok ? "✓" : "!") + "</span>" + msg;
    el.toast.className = "toast show" + (ok ? " ok" : "");
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove("show");
    }, 2600);
  }

  /* ---------------- Boot ---------------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
