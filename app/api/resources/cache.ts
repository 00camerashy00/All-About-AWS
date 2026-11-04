// Shared so saving keys or toggling sync can drop a stale inventory.

const globalStore = globalThis as typeof globalThis & {
  __awsDashInventory?: { at: number; data: unknown } | null;
  __awsDashInventoryRefreshing?: boolean;
  __awsDashInventoryRevision?: number;
  __awsDashInventoryWrite?: Promise<void>;
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

/** Serialize read-merge-write so two scoped rescans cannot drop each other's rows. */
export function updateInventoryCache(update: (current: unknown | null) => unknown): Promise<unknown> {
  const previous = globalStore.__awsDashInventoryWrite ?? Promise.resolve();
  const run = previous.then(() => {
    const current = readCache()?.data ?? null;
    const data = update(current);
    const revision = (globalStore.__awsDashInventoryRevision ?? 0) + 1;
    globalStore.__awsDashInventoryRevision = revision;
    const stamped =
      data && typeof data === "object"
        ? { ...(data as Record<string, unknown>), cacheRevision: revision }
        : data;
    writeInventoryCache(stamped);
    return stamped;
  });
  globalStore.__awsDashInventoryWrite = run.then(
    () => undefined,
    () => undefined
  );
  return run;
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
