import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { clsx } from "clsx";

export function InsightBanner({
  tone = "info",
  title,
  body,
}: {
  tone?: "info" | "warn" | "good";
  title: string;
  body: string;
}) {
  return (
    <div
      className={clsx(
        "card flex gap-3 p-4",
        tone === "warn" && "border-amber-200 bg-amber-50/60",
        tone === "good" && "border-emerald-200 bg-emerald-50/60",
        tone === "info" && "border-sky-200 bg-sky-50/60"
      )}
    >
      <span className="mt-0.5">
        {tone === "warn" ? (
          <AlertTriangle size={18} className="text-amber-600" />
        ) : tone === "good" ? (
          <CheckCircle2 size={18} className="text-emerald-600" />
        ) : (
          <Info size={18} className="text-sky-600" />
        )}
      </span>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-gray-600">{body}</p>
      </div>
    </div>
  );
}
