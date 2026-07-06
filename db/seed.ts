import { db } from "./index.js"; import { lockConfig, roles, settings } from "./schema.js";

const DEFAULT_COURSES = JSON.stringify([
  "קורס קפ״ק",
  "קורס פאראמדיקים א׳",
  "קורס פאראמדיקים ב׳",
  "קורס חובשים",
]);

const ADMIN_ROLE = {
  name: "admin",
  canViewSchedule: true,
  canEditSchedule: true,
  canFillChecklist: true,
  canManageRoles: true,
  canOverrideChecklist: true,
  canViewDashboard: true,
  canViewMonthly: true,
  canViewEngine: true,
  canViewForms: true,
  canViewTracking: true,
  canViewPlacement: true,
  canViewTraineeView: true,
  canViewWeekly: true,
  canViewUsers: true,
  canViewStations: true,
  canViewRoster: true,
  canViewWhiteAmbulance: true,
  allowAtan: true,
  allowWhite: true,
  canViewSwaps: true,
  defaultWeeklyQuota: 0,
  stage1RequiredShifts: 10,
  stage2RequiredShifts: 15,
  stage3RequiredShifts: 20,
  stage4RequiredShifts: 25,
  isSystem: true,
} as const;

const VIEWER_ROLE = {
  name: "viewer",
  canViewSchedule: true,
  canEditSchedule: false,
  canFillChecklist: true,
  canManageRoles: false,
  canOverrideChecklist: false,
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
  allowAtan: true,
  allowWhite: true,
  canViewSwaps: true,
  defaultWeeklyQuota: 0,
  stage1RequiredShifts: 10,
  stage2RequiredShifts: 15,
  stage3RequiredShifts: 20,
  stage4RequiredShifts: 25,
  isSystem: true,
} as const;

async function seedSingletons() {
  await db
    .insert(lockConfig)
    .values({
      id: 1,
      enabled: false,
      day: 4,
      time: "20:00",
    })
    .onConflictDoUpdate({
      target: lockConfig.id,
      set: {
        enabled: false,
        day: 4,
        time: "20:00",
      },
    });

  await db
    .insert(settings)
    .values({
      id: 1,
      minShifts: 0,
      courses: DEFAULT_COURSES,
      crewRevealHours: 0,
      stage1RequiredShifts: 10,
      stage2RequiredShifts: 15,
      stage3RequiredShifts: 20,
      stage4RequiredShifts: 25,
      deadlineReminderHours: 24,
      deadlineReminderLastSent: "",
    })
    .onConflictDoUpdate({
      target: settings.id,
      set: {
        minShifts: 0,
        courses: DEFAULT_COURSES,
        crewRevealHours: 0,
        stage1RequiredShifts: 10,
        stage2RequiredShifts: 15,
        stage3RequiredShifts: 20,
        stage4RequiredShifts: 25,
        deadlineReminderHours: 24,
        deadlineReminderLastSent: "",
      },
    });
}

async function seedSystemRoles() {
  await db.insert(roles).values(ADMIN_ROLE).onConflictDoUpdate({
    target: roles.name,
    set: {
      ...ADMIN_ROLE,
      name: ADMIN_ROLE.name,
    },
  });

  await db.insert(roles).values(VIEWER_ROLE).onConflictDoUpdate({
    target: roles.name,
    set: {
      ...VIEWER_ROLE,
      name: VIEWER_ROLE.name,
    },
  });
}

async function main() {
  await seedSingletons();
  await seedSystemRoles();
  console.log("Seed complete: singletons and system roles are initialized.");
}

main()
  .catch((error) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // postgres-js keeps sockets open by default; ending avoids hanging CLI runs.
    await queryClient.end({ timeout: 5 });
  });
