-- Full reset for public schema, then full rebuild from db/schema.ts-derived migration.
-- WARNING: Destructive. This drops all public tables and their data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  )
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $$;

CREATE TABLE "admin_private_daily_imports" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "station_name" text NOT NULL,
  "shift" text NOT NULL,
  "driver" text DEFAULT '' NOT NULL,
  "paramedic" text DEFAULT '' NOT NULL,
  "source_file_name" text DEFAULT '' NOT NULL,
  "updated_at" timestamp DEFAULT now(),
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "availability" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "date" text NOT NULL,
  "shift_type" text NOT NULL,
  "preference" text NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE "custom_shifts" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "name" text NOT NULL,
  "shift" text NOT NULL,
  "hours" text DEFAULT '' NOT NULL,
  "driver" text DEFAULT '' NOT NULL,
  "paramedic" text DEFAULT '' NOT NULL,
  "intern1" text DEFAULT '' NOT NULL,
  "intern2" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "task_type" text DEFAULT 'shift' NOT NULL,
  "trainees" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "form_completions" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "source" text NOT NULL,
  "ref_id" integer NOT NULL,
  "slot" text NOT NULL,
  "completed" boolean DEFAULT false NOT NULL,
  "not_required" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE "hidden_shifts" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "station_id" integer NOT NULL,
  "is_hidden" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "lock_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "enabled" boolean DEFAULT false NOT NULL,
  "day" integer DEFAULT 4 NOT NULL,
  "time" text DEFAULT '20:00' NOT NULL
);

CREATE TABLE "manual_tutors" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "approved" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "notification_reads" (
  "user_id" integer PRIMARY KEY,
  "seen_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "notifications" (
  "id" serial PRIMARY KEY,
  "user_id" integer,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "message" text DEFAULT '' NOT NULL,
  "is_read" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "placement_notes" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "week_id" text NOT NULL,
  "date" text,
  "shift_id" text,
  "note_text" text DEFAULT '' NOT NULL,
  "created_by" integer NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE "published_weeks" (
  "id" serial PRIMARY KEY,
  "week_start" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "roles" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "can_view_schedule" boolean DEFAULT true NOT NULL,
  "can_edit_schedule" boolean DEFAULT false NOT NULL,
  "can_fill_checklist" boolean DEFAULT false NOT NULL,
  "can_manage_roles" boolean DEFAULT false NOT NULL,
  "can_override_checklist" boolean DEFAULT false NOT NULL,
  "can_view_dashboard" boolean DEFAULT false NOT NULL,
  "can_view_monthly" boolean DEFAULT false NOT NULL,
  "can_view_engine" boolean DEFAULT false NOT NULL,
  "can_view_forms" boolean DEFAULT true NOT NULL,
  "can_view_tracking" boolean DEFAULT false NOT NULL,
  "can_view_placement" boolean DEFAULT true NOT NULL,
  "can_view_trainee_view" boolean DEFAULT false NOT NULL,
  "can_view_weekly" boolean DEFAULT true NOT NULL,
  "can_view_users" boolean DEFAULT false NOT NULL,
  "can_view_stations" boolean DEFAULT false NOT NULL,
  "can_view_roster" boolean DEFAULT false NOT NULL,
  "can_view_white_ambulance" boolean DEFAULT false NOT NULL,
  "allow_atan" boolean DEFAULT true NOT NULL,
  "allow_white" boolean DEFAULT true NOT NULL,
  "can_view_swaps" boolean DEFAULT true NOT NULL,
  "default_weekly_quota" integer DEFAULT 0 NOT NULL,
  "stage_1_required_shifts" integer DEFAULT 10 NOT NULL,
  "stage_2_required_shifts" integer DEFAULT 15 NOT NULL,
  "stage_3_required_shifts" integer DEFAULT 20 NOT NULL,
  "stage_4_required_shifts" integer DEFAULT 25 NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "roster" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "schedules" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "station_id" integer NOT NULL,
  "driver" text DEFAULT '' NOT NULL,
  "paramedic" text DEFAULT '' NOT NULL,
  "intern1" text DEFAULT '' NOT NULL,
  "intern2" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "task_type" text DEFAULT 'shift' NOT NULL,
  "trainees" text DEFAULT '[]' NOT NULL,
  "no_form_required" boolean DEFAULT false NOT NULL,
  "no_form_required_intern1" boolean DEFAULT false NOT NULL,
  "no_form_required_intern2" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE "sessions" (
  "token" text PRIMARY KEY,
  "user_id" integer NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "min_shifts" integer DEFAULT 0 NOT NULL,
  "courses" text DEFAULT '["קורס קפ״ק","קורס פאראמדיקים א׳","קורס פאראמדיקים ב׳","קורס חובשים"]' NOT NULL,
  "crew_reveal_hours" integer DEFAULT 0 NOT NULL,
  "stage_1_required_shifts" integer DEFAULT 10 NOT NULL,
  "stage_2_required_shifts" integer DEFAULT 15 NOT NULL,
  "stage_3_required_shifts" integer DEFAULT 20 NOT NULL,
  "stage_4_required_shifts" integer DEFAULT 25 NOT NULL,
  "deadline_reminder_hours" integer DEFAULT 24 NOT NULL,
  "deadline_reminder_last_sent" text DEFAULT '' NOT NULL
);

CREATE TABLE "stations" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "shift" text NOT NULL,
  "hours" text NOT NULL,
  "is_white_ambulance" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "swap_requests" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "source" text NOT NULL,
  "ref_id" integer NOT NULL,
  "slot" text NOT NULL,
  "station" text DEFAULT '' NOT NULL,
  "shift" text DEFAULT '' NOT NULL,
  "requester_id" integer NOT NULL,
  "requester_name" text DEFAULT '' NOT NULL,
  "coverer_id" integer,
  "coverer_name" text DEFAULT '' NOT NULL,
  "target_user_id" integer,
  "target_shift_id" text,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE "users" (
  "id" serial PRIMARY KEY,
  "full_name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "password_hash" text NOT NULL,
  "role" text DEFAULT 'viewer' NOT NULL,
  "status" text DEFAULT 'Pending' NOT NULL,
  "shift_target" integer DEFAULT 0 NOT NULL,
  "shift_count" integer DEFAULT 0 NOT NULL,
  "course" text DEFAULT '' NOT NULL,
  "active_trainee" boolean DEFAULT true NOT NULL,
  "is_volunteer" boolean DEFAULT false NOT NULL,
  "professional_role" text DEFAULT '' NOT NULL,
  "approved_tutors" text DEFAULT '[]' NOT NULL,
  "is_intern" boolean DEFAULT false NOT NULL,
  "is_approved_tutor" boolean DEFAULT false NOT NULL,
  "shabbat_keeper" boolean DEFAULT false NOT NULL,
  "restrict_night_shifts" boolean DEFAULT false NOT NULL,
  "restrict_weekend_shifts" boolean DEFAULT false NOT NULL,
  "trainee_stage" text DEFAULT '' NOT NULL,
  "custom_stage_targets" boolean DEFAULT false NOT NULL,
  "stage_1_target" integer DEFAULT 0 NOT NULL,
  "stage_2_target" integer DEFAULT 0 NOT NULL,
  "stage_3_target" integer DEFAULT 0 NOT NULL,
  "stage_4_target" integer DEFAULT 0 NOT NULL,
  "is_verified" boolean DEFAULT false NOT NULL,
  "verification_token" text,
  "allow_white" boolean DEFAULT true NOT NULL,
  "allow_atan" boolean DEFAULT true NOT NULL,
  "reset_password_token" text,
  "reset_password_expires" timestamp,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE "white_shift_requests" (
  "id" serial PRIMARY KEY,
  "requester_id" integer NOT NULL,
  "requester_name" text DEFAULT '' NOT NULL,
  "target_date" text NOT NULL,
  "station_id" integer NOT NULL,
  "station_name" text DEFAULT '' NOT NULL,
  "shift" text DEFAULT '' NOT NULL,
  "slot" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reviewed_by" integer,
  "reviewed_at" timestamp,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX "admin_private_daily_imports_date_station_shift_idx" ON "admin_private_daily_imports" ("date","station_name","shift");
CREATE UNIQUE INDEX "availability_user_date_shift_idx" ON "availability" ("user_id","date","shift_type");
CREATE UNIQUE INDEX "form_completions_date_source_ref_slot_idx" ON "form_completions" ("date","source","ref_id","slot");
CREATE UNIQUE INDEX "hidden_shifts_date_station_idx" ON "hidden_shifts" ("date","station_id");
CREATE UNIQUE INDEX "placement_notes_user_date_uniq" ON "placement_notes" ("user_id","date");
CREATE UNIQUE INDEX "published_weeks_week_start_idx" ON "published_weeks" ("week_start");
CREATE UNIQUE INDEX "schedules_date_station_idx" ON "schedules" ("date","station_id");

ALTER TABLE "availability" ADD CONSTRAINT "availability_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

COMMIT;
