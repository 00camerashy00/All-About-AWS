// Shared so saving keys or toggling sync can drop a stale inventory.

const globalStore = globalThis as typeof globalThis & {
  __awsDashInventory?: { at: number; data: unknown } | null;
  __awsDashInventoryRefreshing?: boolean;
};

function readCache() {
  return globalStore.__awsDashInventory ?? null;
}

export const INVENTORY_TTL_MS = 10 * 60 * 1000;

export function readInventoryCache() {
  return readCache();
}

export function writeInventoryCache(data: unknown) {
  globalStore.__awsDashInventory = { at: Date.now(), data };
}

export function resetInventoryCache() {
  globalStore.__awsDashInventory = null;
  globalStore.__awsDashInventoryRefreshing = false;
}

export function isInventoryRefreshing() {
  return Boolean(globalStore.__awsDashInventoryRefreshing);
}

export function setInventoryRefreshing(value: boolean) {
  globalStore.__awsDashInventoryRefreshing = value;
}
