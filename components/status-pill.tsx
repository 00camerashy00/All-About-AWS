import { clsx } from "clsx";
import type { Health } from "@/lib/mock-data";

function healthLabel(status: Health): string {
  if (status === "healthy") return "Healthy";
  if (status === "attention") return "Needs attention";
  return "Critical";
}

export function StatusPill({ status }: { status: Health }) {
  return (
    <span
      className={clsx(
        "pill",
        status === "healthy" && "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
        status === "attention" && "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
        status === "critical" && "bg-red-50 text-red-700 ring-1 ring-red-200"
      )}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          status === "healthy" && "bg-emerald-500",
          status === "attention" && "bg-amber-500",
          status === "critical" && "bg-red-500"
        )}
      />
      {healthLabel(status)}
    </span>
  );
}
