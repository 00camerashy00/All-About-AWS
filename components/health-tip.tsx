import { useState } from "react";
import { StatusPill } from "./status-pill";
import type { Health } from "@/lib/aws-resources";

// Health pill with the waste/attention reason in a hover tooltip.
// Fixed positioning so a scrolling table does not clip it.
export function HealthTip({
  status,
  flags,
}: {
  status: Health;
  flags: string[];
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  if (flags.length === 0) return <StatusPill status={status} />;
  return (
    <span
      className="inline-block"
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPos({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)),
          top: rect.bottom + 8,
        });
      }}
      onMouseLeave={() => setPos(null)}
    >
      <span className="cursor-help">
        <StatusPill status={status} />
      </span>
      {pos && (
        <span
          className="fixed z-50 w-64 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-card"
          style={{ left: pos.left, top: pos.top }}
        >
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
      )}
    </span>
  );
}
