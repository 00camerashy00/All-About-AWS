import type { UsersPayload } from "@/lib/users-types";

const globalStore = globalThis as typeof globalThis & {
  __awsDashUsers?: { at: number; data: UsersPayload } | null;
};

export function usersCacheTtl() {
  const raw = Number(process.env.USERS_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

export function readUsersCache() {
  return globalStore.__awsDashUsers ?? null;
}

export function writeUsersCache(data: UsersPayload) {
  globalStore.__awsDashUsers = { at: Date.now(), data };
}

export function resetUsersCache() {
  globalStore.__awsDashUsers = null;
}
