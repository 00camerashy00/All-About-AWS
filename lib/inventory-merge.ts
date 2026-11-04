import type { Inventory, InventoryScope, WasteItem } from "@/lib/aws-resources";

const SCOPES: InventoryScope[] = ["ec2", "rds", "s3"];

export function wasteSource(item: WasteItem): "ec2" | "rds" | "s3" | "other" {
  if (item.source === "ec2" || item.source === "rds" || item.source === "s3" || item.source === "other") {
    return item.source;
  }
  if (item.title.startsWith("Bucket ")) return "s3";
  if (item.title.startsWith("Database ")) return "rds";
  if (item.title.endsWith(" is stopped")) return "ec2";
  return "other";
}

export function asInventory(value: unknown): Inventory | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Inventory;
  if (candidate.live !== true || !Array.isArray(candidate.instances) || !Array.isArray(candidate.waste)) return null;
  return candidate;
}

/** A missing scope list is a full scan from before scoped refresh existed. */
export function scopeScanned(
  inv: { scannedScopes?: readonly InventoryScope[] | null } | null | undefined,
  scope: InventoryScope
): boolean {
  if (!inv) return false;
  if (!inv.scannedScopes) return true;
  return inv.scannedScopes.includes(scope);
}

/** Disks, snapshots, load balancers, and file systems are collected on a full scan only. */
export function detailScanned(
  inv: { scannedScopes?: readonly InventoryScope[] | null; detailScan?: boolean } | null | undefined
): boolean {
  if (!inv) return false;
  if (typeof inv.detailScan === "boolean") return inv.detailScan;
  return !inv.scannedScopes;
}

/** Replace one scope inside a cached inventory and leave every other scope in place. */
export function mergeInventory(prev: Inventory | null, next: Inventory, scope: InventoryScope): Inventory {
  // No earlier scan: keep the new scope, and leave the others unmarked.
  // Empty arrays for those others are placeholders, not a live empty result.
  if (!prev) return { ...next, scannedScopes: [scope], detailScan: false };
  const scanned = new Set<InventoryScope>(prev.scannedScopes ?? SCOPES);
  scanned.add(scope);
  const scannedScopes = SCOPES.filter((item) => scanned.has(item));
  const detailScan = prev.detailScan ?? !prev.scannedScopes;
  const waste = [
    ...prev.waste.filter((item) => wasteSource(item) !== scope),
    ...next.waste.filter((item) => wasteSource(item) === scope),
  ];
  if (scope === "ec2") {
    const disks = new Map(prev.instances.map((instance) => [instance.id, instance.diskGb]));
    return {
      ...prev,
      instances: next.instances.map((instance) => ({
        ...instance,
        diskGb: instance.diskGb || disks.get(instance.id) || 0,
      })),
      waste,
      scannedScopes,
      detailScan,
    };
  }
  if (scope === "rds") {
    return {
      ...prev,
      databases: next.databases,
      snapshots: [
        ...prev.snapshots.filter((snapshot) => snapshot.store !== "rds"),
        ...next.snapshots.filter((snapshot) => snapshot.store === "rds"),
      ],
      waste,
      scannedScopes,
      detailScan,
    };
  }
  return {
    ...prev,
    buckets: next.buckets,
    waste,
    scannedScopes,
    detailScan,
  };
}
