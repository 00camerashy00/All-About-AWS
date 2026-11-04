import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type StatTone = "yellow" | "amber" | "slate" | "red";

const toneBar: Record<StatTone, string> = {
  yellow: "bg-amber-400",
  amber: "bg-orange-400",
  slate: "bg-zinc-800",
  red: "bg-red-500",
};

const toneIcon: Record<StatTone, string> = {
  yellow: "bg-amber-100 text-amber-700",
  amber: "bg-orange-100 text-orange-700",
  slate: "bg-zinc-100 text-zinc-700",
  red: "bg-red-100 text-red-600",
};

export function StatCard({
  label,
  value,
  caption,
  pct,
  tone,
  icon: Icon,
  active = false,
  onClick,
  action,
}: {
  label: string;
  value: string;
  caption: string;
  pct: number;
  tone: StatTone;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
  action?: ReactNode;
}) {
  const width = Math.min(100, Math.max(0, pct));
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`flex h-7 w-7 items-center justify-center rounded-full ${toneIcon[tone]}`}>
            <Icon size={14} />
          </span>
          <p className="text-sm font-medium text-gray-600">{label}</p>
        </div>
        {action}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${toneBar[tone]}`} style={{ width: `${width}%` }} />
      </div>
      <p className="mt-2 text-xs text-gray-500">{caption}</p>
    </>
  );
  const className = `card w-full p-4 text-left ${active ? "ring-2 ring-zinc-900" : ""}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} aria-pressed={active}>
        {body}
      </button>
    );
  }
  return <section className={className}>{body}</section>;
}
