import { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="muted mt-1 max-w-2xl text-sm leading-relaxed">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</p>
      <p className={`mt-1 text-xs ${accent ?? "text-gray-500"}`}>{sub}</p>
    </div>
  );
}
