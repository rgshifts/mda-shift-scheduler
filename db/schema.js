// ============================================================
//  Database schema — Monthly Shift Scheduling & Trainee Assignment
//  Source of truth for every table. Change here, then run
//  `npx drizzle-kit generate` to emit a migration.
// ============================================================
import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex, } from "drizzle-orm/pg-core";
// Dynamic role-based access control. Each role maps a name (a free-form string —
// 'admin', 'viewer', or any custom Hebrew label like "סדרן" / "מתנדב") to a set
// of permission flags. A user references its role by name via `users.role`, so a
// role's permissions resolve at request time rather than from a hard-coded
// string check. The two built-in roles (admin, viewer) are seeded and flagged
// `is_system` so they can't be deleted; their flags reproduce the prior static
// admin / trainee behavior. Extra flags beyond the four core ones are allowed:
//   • canViewSchedule       — may open the schedule at all
//   • canEditSchedule       — may edit assignments, run the engine, import, etc.
//   • canFillChecklist      — may sign off the trainee's OWN evaluation form
//   • canManageRoles        — may manage users and role definitions
//   • canOverrideChecklist  — high-level bypass: may sign off ANOTHER person's
//                             evaluation form (otherwise reserved to the trainee)
export const roles = pgTable("roles", {
    id: serial().primaryKey(),
    name: text().notNull().unique(),
    canViewSchedule: boolean("can_view_schedule").notNull().default(true),
    canEditSchedule: boolean("can_edit_schedule").notNull().default(false),
    canFillChecklist: boolean("can_fill_checklist").notNull().default(false),
    canManageRoles: boolean("can_manage_roles").notNull().default(false),
    canOverrideChecklist: boolean("can_override_checklist").notNull().default(false),
    // Granular navigation-visibility flags: each gates one sidebar/navbar link so an
    // admin can decide, per role, which sub-tabs are reachable. Pure visibility —
    // functional edit/manage gates still apply inside each feature endpoint.
    canViewDashboard: boolean("can_view_dashboard").notNull().default(false),
    canViewMonthly: boolean("can_view_monthly").notNull().default(false),
    canViewEngine: boolean("can_view_engine").notNull().default(false),
    canViewForms: boolean("can_view_forms").notNull().default(true),
    canViewTracking: boolean("can_view_tracking").notNull().default(false),
    canViewPlacement: boolean("can_view_placement").notNull().default(true),
    canViewTraineeView: boolean("can_view_trainee_view").notNull().default(false),
    canViewWeekly: boolean("can_view_weekly").notNull().default(true),
    canViewUsers: boolean("can_view_users").notNull().default(false),
    canViewStations: boolean("can_view_stations").notNull().default(false),
    canViewRoster: boolean("can_view_roster").notNull().default(false),
    canViewWhiteAmbulance: boolean("can_view_white_ambulance").notNull().default(false),
    // Site-scope visibility gates. Both default to true so existing roles/users keep
    // full access immediately after migration unless explicitly restricted later.
    allowAtan: boolean("allow_atan").notNull().default(true),
    allowWhite: boolean("allow_white").notNull().default(true),
    canViewSwaps: boolean("can_view_swaps").notNull().default(true),
    // Default WEEKLY shift quota for users assigned this role. Pre-populates a
    // user's personal weekly target (users.shift_target) on role assignment unless
    // the admin sets an explicit value; 0 means no default (fall back to global min).
    defaultWeeklyQuota: integer("default_weekly_quota").notNull().default(0),
    // Per-ROLE required number of COMPLETED shifts to clear each certification stage.
    // These drive the trainee progress tracker on a per-role basis — different roles
    // (e.g. קפ״צ vs קפ״מ) can demand different shift counts to advance through the
    // same four stages. Each value is the count needed to clear that one stage (not
    // cumulative); the client walks a trainee's total `users.shift_count` through the
    // four targets of THEIR role. Editable inline in the roles-permissions matrix,
    // right beside the weekly quota. Defaults seed a sensible ladder for fresh roles.
    stage1RequiredShifts: integer("stage_1_required_shifts").notNull().default(10),
    stage2RequiredShifts: integer("stage_2_required_shifts").notNull().default(15),
    stage3RequiredShifts: integer("stage_3_required_shifts").notNull().default(20),
    stage4RequiredShifts: integer("stage_4_required_shifts").notNull().default(25),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
});
// Registered accounts. `password_hash` stores a bcrypt hash produced by the
// pgcrypto crypt()/gen_salt('bf') functions — plaintext passwords are never
// persisted. New sign-ups default to a pending, viewer-only account. `role`
// holds a role NAME resolved against the `roles` table for permission checks.
export const users = pgTable("users", {
    id: serial().primaryKey(),
    fullName: text("full_name").notNull(),
    email: text().notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text().notNull().default("viewer"), // 'admin' | 'viewer'
    status: text().notNull().default("Pending"), // 'Approved' | 'Pending'
    // Personal WEEKLY minimum-shift target for this trainee. 0 = no target set;
    // the admin panel compares each trainee's live weekly count against their own
    // value, and the auto-assign engine caps weekly placements at it.
    shiftTarget: integer("shift_target").notNull().default(0),
    // Running lifetime tally of COMPLETED shifts for this trainee. Auto-maintained:
    // the server bumps it +1 when the trainee's evaluation form for a shift is
    // marked "בוצע" (completed) and -1 (floored at 0) when that same form is
    // un-marked, so ordinary use keeps it in step with real completions. The admin
    // panel also exposes it as a directly-editable number, letting a manager
    // override the value to reconcile any historical mismatch or discrepancy.
    shiftCount: integer("shift_count").notNull().default(0),
    // Training course this trainee belongs to (free text, e.g. "קורס קפ״ק").
    // Empty string = not yet assigned to a course.
    course: text().notNull().default(""),
    // Whether the trainee is still active ("משתלם פעיל"). When false the trainee
    // is considered graduated/released ("סיים/השתחרר") and is excluded from the
    // auto-assignment quota engine.
    activeTrainee: boolean("active_trainee").notNull().default(true),
    // External / volunteering paramedic or staff member who works shifts but does
    // not necessarily need full system login access. Grouped separately in the
    // user-management panel.
    isVolunteer: boolean("is_volunteer").notNull().default(false),
    // Professional sub-role for the mentorship workflow, ORTHOGONAL to the access
    // `role` above: '' (none), 'stajer' ("סטאז'ר/ית" — a trainee paramedic being
    // mentored) or 'tutor' ("טיוטור/ית" — a senior paramedic who mentors). It drives
    // the auto-assign engine's High-Priority Mentorship Pairing rule and its
    // intern-escort safety constraint, neither of which touches the permission model.
    professionalRole: text("professional_role").notNull().default(""),
    // For a 'stajer' only: the explicit list of tutors approved to mentor this
    // intern ("טיוטורים מאושרים"), stored as a JSON-encoded array of tutor user ids
    // (e.g. "[3,7]"). Empty array = no approved tutor yet, so the safety constraint
    // keeps this intern out of every auto-assigned escort slot until one is linked.
    // RETAINED-BUT-UNUSED: superseded by the streamlined `isIntern`/`isApprovedTutor`
    // flags below. Kept in the schema so it matches the live table exactly and the
    // migration diff stays a clean column-add (no destructive drop). The app no
    // longer reads or writes `professionalRole`/`approvedTutors`.
    approvedTutors: text("approved_tutors").notNull().default("[]"),
    // "סטאז'ר" (Intern): a single, manager-controlled flag marking a trainee who may
    // be paired into a מלווה slot by the global tutor/intern auto-assign pool. Set
    // from the simple toggle in the user-management table.
    isIntern: boolean("is_intern").notNull().default(false),
    // "טיוטור מאושר" (Approved Tutor): a station paramedic the manager approved (in
    // the "ניהול סגל ורשימות" tab) to host paired trainees. Pure scheduling
    // eligibility — it does NOT affect login credentials or registration status.
    isApprovedTutor: boolean("is_approved_tutor").notNull().default(false),
    // "שומר שבת" (Shabbat Keeper): a trainee who does not work on Shabbat. When set,
    // the auto-assign engine treats every Friday-evening and all Saturday shifts
    // (Saturday morning / afternoon-evening / night) as hard-unavailable for this
    // trainee — exactly as if they had submitted a 'cannot' preference for each —
    // so they are never auto-placed into a Shabbat slot. Purely a scheduling
    // constraint; it does not touch login, role, or registration state.
    shabbatKeeper: boolean("shabbat_keeper").notNull().default(false),
    // "לא זמין לביצוע משמרות לילה" (Night-shift restriction): a trainee who may not
    // work night ("לילה") shifts. When set, the auto-assign engine treats every
    // night slot as hard-unavailable for this trainee (like a 'cannot' preference),
    // and the availability API rejects any night preference they try to submit — so
    // they are never placed on, nor can request, a night shift. Purely a scheduling
    // constraint; it never touches login, role, or registration state.
    restrictNightShifts: boolean("restrict_night_shifts").notNull().default(false),
    // "ללא שישי+שבת" (Weekend restriction): a trainee who may not work any Friday or
    // Saturday shift. When set, the shift-request form auto-locks every Friday and
    // Saturday slot (morning / evening / night) to "לא זמין" (cannot) so the trainee
    // can neither request nor be scheduled on them; the availability API rejects any
    // assignable weekend preference and the auto-assign engine treats every Fri/Sat
    // slot as hard-unavailable. Broader than "שומר שבת" (which only bars Friday-eve
    // and Saturday) — this bars the full Friday day too. Purely a scheduling
    // constraint; it never touches login, role, or registration state.
    restrictWeekendShifts: boolean("restrict_weekend_shifts").notNull().default(false),
    // "שלב הסמכה" (Trainee certification stage): the authorization level a trainee has
    // reached, gating which shift configurations the auto-assign engine may place them
    // into. One of '' (unset — no stage restriction), 'stage_1' (משמרות צפייה —
    // observation), 'stage_2' (משמרות אנמנזה — anamnesis), 'stage_3' (ניהול מקרים לא
    // דחופים — non-urgent case management) or 'stage_4' (ניהול כל המקרים — full case
    // management). Stages 1–2 are supervised levels: the engine only auto-places such
    // a trainee on a shift where an approved tutor is already present, exactly like the
    // "סטאז'ר" pairing safety rule. Stages 3–4 (and unset) carry no extra supervision
    // constraint. Purely a scheduling concern; it never touches login or permissions.
    traineeStage: text("trainee_stage").notNull().default(""),
    // "מסלול מותאם אישית" (Custom / non-standard-trainee track). Off by default: a
    // trainee's certification progress measures against the shared per-ROLE stage
    // targets (see `roles.stageNRequiredShifts`). When an admin flips this on for an
    // exceptional profile, the four per-user overrides below take precedence, letting
    // a manager hand-tune a bespoke ladder (e.g. Stage 1 = 15, Stage 2 = 20) for
    // someone who does not follow the standard course. Purely drives the progress
    // tracker's target math; it never touches login, role, or the auto-assign engine.
    customStageTargets: boolean("custom_stage_targets").notNull().default(false),
    // Per-user override of the completed-shift count required to clear each of the
    // four certification stages. Only consulted when `customStageTargets` is true.
    // 0 means "not overridden" — that single stage still falls back to the user's
    // role/global target — so an admin can override just one or two stages and leave
    // the rest on the standard ladder. Each value is that one stage's requirement
    // (not cumulative), mirroring `roles.stageNRequiredShifts`.
    stage1Target: integer("stage_1_target").notNull().default(0),
    stage2Target: integer("stage_2_target").notNull().default(0),
    stage3Target: integer("stage_3_target").notNull().default(0),
    stage4Target: integer("stage_4_target").notNull().default(0),
    // Email-verification state. A fresh sign-up is unverified; registration issues a
    // one-time `verification_token` mailed as a /verify-email?token=… link, and
    // visiting it flips `is_verified` to true and clears the token. ORTHOGONAL to
    // `status` (admin access approval): an admin can also flip `is_verified` straight
    // from the user-management panel without the trainee ever clicking the link.
    isVerified: boolean("is_verified").notNull().default(false),
    verificationToken: text("verification_token"), // null once verified / never issued
    // Password-reset ("forgot password") flow. `forgot-password` stores a one-time
    // `reset_password_token` plus a short `reset_password_expires` deadline and mails
    // a /reset-password?token=… link; `reset-password` accepts the token before the
    // deadline, rewrites the bcrypt hash and clears both columns. Both null when no
    // reset is in flight.
    // "מאושר לבן" (Allow White Shifts): האם המשתמש מאושר לביצוע משמרות ברכב לבן.
    allow_white: boolean("allow_white").notNull().default(true),
    // "מאושר אט\"ן" (Allow Atan Shifts): האם המשתמש מאושר לביצוע משמרות באט"ן.
    allow_atan: boolean("allow_atan").notNull().default(true),
    resetPasswordToken: text("reset_password_token"),
    resetPasswordExpires: timestamp("reset_password_expires"),
    createdAt: timestamp("created_at").defaultNow(),
});
// Opaque server-issued session tokens. The browser stores only the token; the
// server resolves it to a user (and role) on every protected request.
export const sessions = pgTable("sessions", {
    token: text().primaryKey(),
    userId: integer("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
});
// Admin-managed quick-select names for the shift-assignment comboboxes.
export const roster = pgTable("roster", {
    id: serial().primaryKey(),
    name: text().notNull().unique(),
    createdAt: timestamp("created_at").defaultNow(),
});
// Custom station configurations. `shift` is one of morning/evening/night and
// drives the colour band and grouping order in the day view.
export const stations = pgTable("stations", {
    id: serial().primaryKey(),
    name: text().notNull(),
    shift: text().notNull(), // 'morning' | 'evening' | 'night'
    hours: text().notNull(),
    // White Ambulance context flag. Keeps these station rows logically segregated
    // from the main ALS / trainee scheduler while still allowing a focused admin-
    // only management surface and month views.
    isWhiteAmbulance: boolean("is_white_ambulance").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
});
// One row per (date, station): the final daily assignment. Each slot holds free
// text or a linked person's name. A unique index lets the API upsert per save.
export const schedules = pgTable("schedules", {
    id: serial().primaryKey(),
    date: text().notNull(), // ISO date 'YYYY-MM-DD'
    stationId: integer("station_id").notNull(),
    driver: text().notNull().default(""),
    paramedic: text().notNull().default(""),
    intern1: text().notNull().default(""),
    intern2: text().notNull().default(""),
    note: text().notNull().default(""),
    // "סוג המשימה" — what kind of entry this row is. 'shift' (משמרת, the default)
    // keeps the classic driver/paramedic/escort crew. Any other value — 'training'
    // (יום תרגול / עיון), 'ceremony' (טקס) or 'other' (אחר) — is an event that has
    // NO driver/paramedic crew; its participants live in `trainees` instead.
    taskType: text("task_type").notNull().default("shift"),
    // Free-form participant list ("משתלמים") for non-shift task types, stored as a
    // JSON-encoded array of names (e.g. '["דנה","רון"]'). Empty array for a plain
    // 'shift' row, whose people live in the driver/paramedic/intern columns above.
    trainees: text().notNull().default("[]"),
    // "משמרת ללא טופס" — when true this shift needs no trainee-evaluation form
    // (e.g. a volunteer-only crew). Publishing the week skips the automated form
    // email for any shift flagged here, regardless of the chosen email target.
    // Legacy shift-level flag, kept for backward compatibility; the per-escort
    // flags below supersede it (either being set excludes that escort).
    noFormRequired: boolean("no_form_required").notNull().default(false),
    // Per-escort "no form required" flags: each ambulance escort (מלווה א׳ /
    // מלווה ב׳) can be marked independently so a volunteer in one seat is skipped
    // while a course trainee in the other still gets the form flow.
    noFormRequiredIntern1: boolean("no_form_required_intern1").notNull().default(false),
    noFormRequiredIntern2: boolean("no_form_required_intern2").notNull().default(false),
    updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [uniqueIndex("schedules_date_station_idx").on(t.date, t.stationId)]);
// Admin-private daily Excel import snapshot. This holds the parsed נהג/ת אט״ן /
// פראמדיק/ית roster for one date without touching the trainee-facing schedule
// rows, so the import pipeline stays isolated from the core assignment tables.
export const adminPrivateDailyImports = pgTable("admin_private_daily_imports", {
    id: serial().primaryKey(),
    date: text().notNull(),
    stationName: text("station_name").notNull(),
    shift: text().notNull(), // 'morning' | 'evening' | 'night'
    driver: text().notNull().default(""),
    paramedic: text().notNull().default(""),
    sourceFileName: text("source_file_name").notNull().default(""),
    updatedAt: timestamp("updated_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
}, (t) => [uniqueIndex("admin_private_daily_imports_date_station_shift_idx").on(t.date, t.stationName, t.shift)]);
// Per-day station-visibility overrides. One row controls one station on one
// specific date without touching the global station list: `isHidden = true`
// removes it from the day's active layout, while `isHidden = false` explicitly
// restores a station that would otherwise be hidden by a default backend rule.
// The day view, restore panel, save logic, and auto-assign engine all resolve
// visibility through this table. A unique index keeps a (date, station) pair
// idempotent.
export const hiddenShifts = pgTable("hidden_shifts", {
    id: serial().primaryKey(),
    date: text().notNull(), // ISO date 'YYYY-MM-DD'
    stationId: integer("station_id").notNull(),
    isHidden: boolean("is_hidden").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
}, (t) => [uniqueIndex("hidden_shifts_date_station_idx").on(t.date, t.stationId)]);
// Per-day custom shifts added on the fly from the day view. Unlike `stations`
// (a global list reused every day), each row here belongs to one specific date,
// so an admin can spin up an extra station for a single day without polluting the
// permanent station list. Definition and assignment live together in one row —
// keyed only by date — which sidesteps any id collision with the (date, stationId)
// namespace used by `schedules`. Slots mirror the schedule columns so the day view
// renders and saves a custom shift exactly like a regular station.
export const customShifts = pgTable("custom_shifts", {
    id: serial().primaryKey(),
    date: text().notNull(), // ISO date 'YYYY-MM-DD'
    name: text().notNull(),
    shift: text().notNull(), // 'morning' | 'evening' | 'night'
    hours: text().notNull().default(""),
    driver: text().notNull().default(""),
    paramedic: text().notNull().default(""),
    intern1: text().notNull().default(""),
    intern2: text().notNull().default(""),
    note: text().notNull().default(""),
    // Mirrors `schedules.task_type` / `schedules.trainees` so a per-day custom shift
    // can also be a non-shift event (training / ceremony / other) whose participants
    // are the free-form `trainees` list rather than the driver/paramedic crew.
    taskType: text("task_type").notNull().default("shift"),
    trainees: text().notNull().default("[]"),
    createdAt: timestamp("created_at").defaultNow(),
});
// Trainee availability matrix: one row per (user, date, shift type) carrying the
// preference — 'prefer' (green), 'avoid' (orange) or 'cannot' (red).
export const availability = pgTable("availability", {
    id: serial().primaryKey(),
    userId: integer("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    date: text().notNull(), // ISO date 'YYYY-MM-DD'
    shiftType: text("shift_type").notNull(), // 'morning' | 'evening' | 'night'
    preference: text().notNull(), // 'prefer' | 'avoid' | 'cannot'
    updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
    uniqueIndex("availability_user_date_shift_idx").on(t.userId, t.date, t.shiftType),
]);
// Singleton (id = 1) holding the weekly availability lock deadline.
export const lockConfig = pgTable("lock_config", {
    id: integer().primaryKey().default(1),
    enabled: boolean().notNull().default(false),
    day: integer().notNull().default(4), // 0 = Sunday … 4 = Thursday
    time: text().notNull().default("20:00"), // 'HH:MM'
});
// Singleton (id = 1) holding global app settings. `min_shifts` is the minimum
// number of shifts an admin expects each trainee to be scheduled for; the admin
// panel compares each trainee's live assignment count against it.
export const settings = pgTable("settings", {
    id: integer().primaryKey().default(1),
    minShifts: integer("min_shifts").notNull().default(0),
    // Global list of training courses offered by the org, stored as a JSON-encoded
    // array of names. Lives here in the singleton settings row rather than its own
    // table so the whole app configuration stays in one place; the API
    // parses/serialises it on each call. The column default seeds the four courses
    // the app previously hard-coded, so existing installs keep them automatically;
    // an admin can then rename, add, or clear them. An explicitly empty array ([])
    // is a valid state (only the "unassigned" fallback remains in the dropdown).
    courses: text()
        .notNull()
        .default('["קורס קפ״ק","קורס פאראמדיקים א׳","קורס פאראמדיקים ב׳","קורס חובשים"]'),
    // Generic-crew (driver / paramedic) name-reveal window, in hours before each
    // shift starts. For trainee and view-only accounts the crew names stay masked
    // until the current time is within this many hours of the shift start; 0
    // disables masking entirely (names always shown). Admins and the offline demo
    // mode always see the real names regardless of this value.
    crewRevealHours: integer("crew_reveal_hours").notNull().default(0),
    // Required number of COMPLETED shifts to finish each certification stage — the
    // admin-configurable targets that drive a trainee's progress tracker. Each
    // value is the count needed to clear that one stage (not cumulative); the
    // client sums them to place a trainee on the path from their total
    // `users.shift_count`. The defaults seed a sensible ladder so a fresh install
    // shows meaningful progress before an admin ever opens the settings form.
    stage1RequiredShifts: integer("stage_1_required_shifts").notNull().default(10),
    stage2RequiredShifts: integer("stage_2_required_shifts").notNull().default(15),
    stage3RequiredShifts: integer("stage_3_required_shifts").notNull().default(20),
    stage4RequiredShifts: integer("stage_4_required_shifts").notNull().default(25),
    // Automated deadline email reminder — how many hours BEFORE the weekly
    // availability-submission deadline a trainee who still has not submitted gets an
    // automatic reminder email. Admin-configurable from the settings form; 24h is the
    // product default. The scheduled `deadline-reminder` function reads this value.
    deadlineReminderHours: integer("deadline_reminder_hours").notNull().default(24),
    // Bookkeeping for that scheduled reminder: the ISO timestamp of the deadline the
    // last reminder batch was dispatched for. The cron fires every few minutes, so
    // this guard ensures a given deadline is emailed exactly once. Empty until the
    // first batch ever goes out.
    deadlineReminderLastSent: text("deadline_reminder_last_sent").notNull().default(""),
});
// Station notification center ("מרכז התראות"). One row per notification. A row is
// either targeted at one recipient (`user_id` set) or GLOBAL/broadcast when
// `user_id` is null — a null row surfaces in every user's bell. `type` is one of
// 'swap_request' | 'schedule_published' | 'deadline_warning' | 'admin_broadcast' |
// 'schedule_changed'. `is_read` is per-row; a global row is marked read only for the
// user who dismisses it via a companion read-marker (see the API's read handling),
// but for simplicity the app treats "mark all as read" as flipping the user's own
// targeted rows and hiding globals older than their last read — kept lean here by
// storing the flag directly and letting the client dim already-seen items.
export const notifications = pgTable("notifications", {
    id: serial().primaryKey(),
    userId: integer("user_id"), // null = global / broadcast to everyone
    type: text().notNull(),
    title: text().notNull(),
    message: text().notNull().default(""),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
});
// Per-user "seen" watermark for GLOBAL (user_id = null) notifications. A global row
// can't carry a per-user read flag, so instead we record the timestamp at which each
// user last hit "mark all as read"; any global notification created at or before that
// instant is considered read for that user. One row per user (id = userId).
export const notificationReads = pgTable("notification_reads", {
    userId: integer("user_id").primaryKey(),
    seenAt: timestamp("seen_at").notNull().defaultNow(),
});
// Trainee-evaluation form ("טופס חניכה / הערכה") completion tracking. One row
// marks a single intern slot of one shift as having its form filled in — the
// `intern_form_completed_v1` status surfaced by the Forms Checklist tab. A shift
// is identified by its date plus (source, refId): `source` is 'station' (refId =
// stations.id, matching a schedules row) or 'custom' (refId = custom_shifts.id),
// and `slot` is the intern column it belongs to ('intern1' | 'intern2'). Keeping
// completion in its own table leaves the schedule rows untouched and lets the
// unique (date, source, ref_id, slot) index upsert one flag per assigned trainee.
export const formCompletions = pgTable("form_completions", {
    id: serial().primaryKey(),
    date: text().notNull(), // ISO date 'YYYY-MM-DD'
    source: text().notNull(), // 'station' | 'custom'
    refId: integer("ref_id").notNull(), // stations.id or custom_shifts.id
    slot: text().notNull(), // 'intern1' | 'intern2'
    completed: boolean().notNull().default(false),
    // "לא נדרש טופס" — an escort who is NOT a trainee needs no evaluation form, so
    // an admin marks the slot as not-required. Such a slot is then excluded from
    // the "דוח טפסים חסרים" (missing-forms report). Orthogonal to `completed`:
    // a slot is "missing" only when it is assigned, not completed AND not flagged
    // here. Lives on the same (date, source, ref_id, slot) row as the completion.
    notRequired: boolean("not_required").notNull().default(false),
    updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
    uniqueIndex("form_completions_date_source_ref_slot_idx").on(t.date, t.source, t.refId, t.slot),
]);
// Additive list of weeks published to trainees. Each row is one published week,
// identified by its Sunday (the Israeli week start) in `week_start`. A trainee
// may see a day only when the Sunday of that day's week appears here; every
// other day is locked behind the "not yet published" placeholder. Admins are
// never restricted. Publishing a week adds a row; un-publishing removes it — so
// any number of (non-contiguous) weeks can be open at once. Replaces the old
// single-week `publish_config` singleton.
export const publishedWeeks = pgTable("published_weeks", {
    id: serial().primaryKey(),
    weekStart: text("week_start").notNull(), // ISO Sunday 'YYYY-MM-DD'
    createdAt: timestamp("created_at").defaultNow(),
}, (t) => [uniqueIndex("published_weeks_week_start_idx").on(t.weekStart)]);
// Manually-entered tutors ("טיוטורים") that an admin adds by name from the
// "ניהול סגל ורשימות" tab, independent of the registered-user list. Unlike
// `users.is_approved_tutor` (a flag on an actual account), a manual tutor is a
// free-text name — useful for a paramedic who hosts trainees but has no system
// login. `approved` is toggled in place from the same table and mirrors the
// approved-tutor eligibility used elsewhere.
export const manualTutors = pgTable("manual_tutors", {
    id: serial().primaryKey(),
    name: text().notNull(),
    approved: boolean().notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
});
// Shift-swap marketplace ("לוח החלפות"). One row per swap request. A trainee opens
// a request on an upcoming shift they hold (`status` = 'open', ממתין למחליף); another
// trainee offers to cover it (Tier-1 approval → `status` = 'pending_admin', ממתין
// לאישור מנהל, recording the coverer); an admin finalises it ('approved') which
// transfers the slot to the coverer, or rejects it ('rejected'), and the requester
// may withdraw an open request ('cancelled'). The shift is identified exactly like a
// form-completion row — its date plus (source, refId, slot) — so the finaliser can
// locate and rewrite the right assignment. `station`/`shift` are denormalised labels
// captured at request time so the marketplace can render without re-joining.
export const swapRequests = pgTable("swap_requests", {
    id: serial().primaryKey(),
    date: text().notNull(), // ISO date 'YYYY-MM-DD' of the shift being given away
    source: text().notNull(), // 'station' | 'custom'
    refId: integer("ref_id").notNull(), // stations.id or custom_shifts.id
    slot: text().notNull(), // 'intern1' | 'intern2'
    station: text().notNull().default(""), // denormalised station/location name
    shift: text().notNull().default(""), // denormalised band 'morning' | 'evening' | 'night'
    requesterId: integer("requester_id").notNull(),
    requesterName: text("requester_name").notNull().default(""),
    covererId: integer("coverer_id"), // null until someone offers to cover
    covererName: text("coverer_name").notNull().default(""),
    // "החלפה ראש בראש" (Head-to-Head direct swap). Both nullable: a plain request
    // leaves them null and goes to the general marketplace pool; a direct request
    // pins `target_user_id` to one trainee and, optionally, `target_shift_id` to the
    // specific upcoming shift of theirs the requester wants in return (stored as the
    // composite `date|source|refId|slot` identifier). A targeted request is hidden
    // from the general pool and surfaced only to that one target user, who becomes
    // the coverer by accepting; the dual-approval (admin-finalise) flow is unchanged.
    targetUserId: integer("target_user_id"), // null = open to the whole pool
    targetShiftId: text("target_shift_id"), // null = no specific return shift named
    // 'open' → 'pending_admin' → 'approved'; plus terminal 'cancelled' / 'rejected'.
    status: text().notNull().default("open"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});
// White-ambulance manual placement requests. A requester picks one white-station
// slot (date + station + role slot) and lands in the pending queue. A manager
// approves ('approved') to commit that person into the live white schedule row,
// or rejects ('rejected'). The queue is intentionally simple/manual only.
export const whiteShiftRequests = pgTable("white_shift_requests", {
    id: serial().primaryKey(),
    requesterId: integer("requester_id").notNull(),
    requesterName: text("requester_name").notNull().default(""),
    targetDate: text("target_date").notNull(), // ISO date 'YYYY-MM-DD'
    stationId: integer("station_id").notNull(),
    stationName: text("station_name").notNull().default(""),
    shift: text().notNull().default(""), // denormalized shift band for quick display
    slot: text().notNull(), // 'driver' | 'medic' | 'intern1' | 'intern2'
    status: text().notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at"),
    note: text().notNull().default(""),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});
// Placement / out-of-station deployment notes ("הערות שיבוץ ומרחב"). A free-text
// note attached to one trainee for one week, telling them where they are deployed
// when it differs from their home station (e.g. a reinforcement shift at Bnei Brak
// or a general regional assignment). Written only by schedulers/admins; read by the
// target trainee for their own rows and by staff for everyone. A note is targeted
// at a specific (trainee, day) — and optionally a specific shift band on that day —
// so trainees only ever see the deployment that concerns them. The write path
// upserts on the (user, date) pair.
export const placementNotes = pgTable("placement_notes", {
    id: serial().primaryKey(),
    userId: integer("user_id").notNull(), // the target trainee
    weekId: text("week_id").notNull(), // week-start ISO 'YYYY-MM-DD' (Sunday), derived from date
    date: text("date"), // the specific deployment day, ISO 'YYYY-MM-DD'
    shiftId: text("shift_id"), // optional shift band on that day: morning/evening/night
    noteText: text("note_text").notNull().default(""),
    createdBy: integer("created_by").notNull(), // authoring admin/scheduler
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
    userDateUniq: uniqueIndex("placement_notes_user_date_uniq").on(t.userId, t.date),
}));
