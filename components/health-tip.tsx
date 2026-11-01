import { StatusPill } from "./status-pill";
import type { Health } from "@/lib/aws-resources";

// Health pill with the waste/attention reason in a hover tooltip.
// Table wrappers need `lg:overflow-visible` so the tooltip isn't clipped.
export function HealthTip({
  status,
  flags,
}: {
  status: Health;
  flags: string[];
}) {
  if (flags.length === 0) return <StatusPill status={status} />;
  return (
    <span className="group relative inline-block">
      <span className="cursor-help">
        <StatusPill status={status} />
      </span>
      <span className="absolute left-0 top-full z-30 mt-2 hidden w-64 group-hover:block">
        <span className="block rounded-xl border border-gray-200 bg-white p-3 text-left shadow-card">
          <span className="block text-xs font-semibold text-gray-900">
            Why this needs attention
          </span>
          <ul className="mt-1.5 space-y-1">
            {flags.map((f) => (
              <li key={f} className="text-xs leading-relaxed text-gray-600">
                • {f}
              </li>
            ))}
          </ul>
          <span className="mt-1.5 block text-xs font-medium text-gray-900">
            Click the name for details →
          </span>
        </span>
      </span>
    </span>
  );
}
