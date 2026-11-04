// Sizing labels for the Resources tables.
// Derived only from metrics the inventory already holds. Missing numbers stay Unknown.

export const PROVISION_CHOICES = [
  "Under-provisioned",
  "Over-provisioned",
  "Right-sized",
  "Unknown",
] as const;

export type ProvisionLabel = (typeof PROVISION_CHOICES)[number];

const CPU_UNDER = 80;
const CPU_OVER = 10;
/** Used storage at or above this means free space is low (the inventory's critical line). */
const STORAGE_USED_UNDER = 85;
/** Used storage below the inventory's watch line counts as comfortable free space. */
const STORAGE_USED_COMFORTABLE = 70;
const CONNECTIONS_NEAR_MAX = 80;

export function ec2Provision(state: string, cpu: number | null): ProvisionLabel {
  if (state !== "running" || cpu == null || !Number.isFinite(cpu)) return "Unknown";
  if (cpu >= CPU_UNDER) return "Under-provisioned";
  if (cpu <= CPU_OVER) return "Over-provisioned";
  return "Right-sized";
}

export function ec2ProvisionDetail(state: string, cpu: number | null): string {
  if (state !== "running") return "Stopped, so a low CPU reading is not treated as over-provisioned.";
  if (cpu == null || !Number.isFinite(cpu)) return "CloudWatch did not return a 7-day CPU average.";
  return `7-day average CPU ${cpu}%.`;
}

export function rdsProvision(input: {
  available: boolean;
  cpu: number | null;
  storageUsedPct: number | null;
  connectionPct: number | null;
}): ProvisionLabel {
  const cpu = finite(input.cpu);
  const storage = finite(input.storageUsedPct);
  const connections = finite(input.connectionPct);
  if (
    (cpu != null && cpu >= CPU_UNDER) ||
    (storage != null && storage >= STORAGE_USED_UNDER) ||
    (connections != null && connections >= CONNECTIONS_NEAR_MAX)
  ) {
    return "Under-provisioned";
  }
  if (!input.available) return "Unknown";
  const comfortable = storage != null && storage < STORAGE_USED_COMFORTABLE;
  if (cpu != null && cpu <= CPU_OVER && comfortable) return "Over-provisioned";
  if (cpu != null && cpu > CPU_OVER && cpu < CPU_UNDER && storage != null && storage < STORAGE_USED_UNDER) {
    return "Right-sized";
  }
  return "Unknown";
}

export function rdsProvisionDetail(input: {
  available: boolean;
  cpu: number | null;
  storageUsedPct: number | null;
  connectionPct: number | null;
}): string {
  const parts: string[] = [];
  const cpu = finite(input.cpu);
  const storage = finite(input.storageUsedPct);
  const connections = finite(input.connectionPct);
  parts.push(cpu == null ? "CPU was not returned." : `7-day average CPU ${cpu}%.`);
  parts.push(storage == null ? "Free storage was not returned." : `Storage ${storage}% used.`);
  parts.push(
    connections == null
      ? "Connection headroom was not returned."
      : `Connections about ${connections}% of the class maximum.`
  );
  if (!input.available) parts.push("Database is not available, so low CPU is not treated as over-provisioned.");
  return parts.join(" ");
}

/** S3, disks, snapshots, and file systems have no size limit in this inventory. */
export function unknownProvision(): ProvisionLabel {
  return "Unknown";
}

function finite(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}
