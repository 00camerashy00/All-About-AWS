"use client";

import { Filter } from "lucide-react";
import { clsx } from "clsx";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type ColumnKind = "text" | "choice";

export type FilterColumn<T> = {
  id: string;
  label: string;
  kind: ColumnKind;
  /** When set, the choice menu lists these values even if a row does not have them yet. */
  choices?: string[];
  text: (row: T) => string;
  render: (row: T) => ReactNode;
};

type TextFilters = Record<string, string>;
type ChoiceFilters = Record<string, string[]>;

export function FilterTable<T>({
  rows,
  columns,
  rowKey,
  minWidth = 720,
  empty = "Nothing matches.",
  detail,
}: {
  rows: T[];
  columns: FilterColumn<T>[];
  rowKey: (row: T) => string;
  minWidth?: number;
  empty?: string;
  detail?: (row: T) => ReactNode | null;
}) {
  const [textFilters, setTextFilters] = useState<TextFilters>({});
  const [choiceFilters, setChoiceFilters] = useState<ChoiceFilters>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    return rows.filter((row) =>
      columns.every((column) => {
        const value = column.text(row);
        if (column.kind === "text") {
          const query = (textFilters[column.id] ?? "").trim().toLowerCase();
          if (!query) return true;
          return value.toLowerCase().includes(query);
        }
        const selected = choiceFilters[column.id] ?? [];
        if (selected.length === 0) return true;
        return selected.includes(value);
      })
    );
  }, [rows, columns, textFilters, choiceFilters]);

  const active = (column: FilterColumn<T>) =>
    column.kind === "text"
      ? Boolean((textFilters[column.id] ?? "").trim())
      : (choiceFilters[column.id] ?? []).length > 0;

  return (
    <div
      ref={scrollRef}
      className="max-h-[min(32rem,calc(100dvh-16rem))] overflow-auto overscroll-contain"
    >
      <table className="w-full border-separate border-spacing-0 text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="text-xs uppercase tracking-wide text-gray-400">
            {columns.map((column) => (
              <th
                key={column.id}
                className="sticky top-0 z-20 bg-white px-4 py-3 font-medium shadow-[inset_0_-1px_0_0_#f3f4f6]"
              >
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {column.label}
                  <ColumnFilterControl
                    column={column}
                    rows={rows}
                    open={openId === column.id}
                    active={active(column)}
                    textValue={textFilters[column.id] ?? ""}
                    selected={choiceFilters[column.id] ?? []}
                    onToggle={() => setOpenId((current) => (current === column.id ? null : column.id))}
                    onClose={() => setOpenId((current) => (current === column.id ? null : current))}
                    onText={(value) => setTextFilters((current) => ({ ...current, [column.id]: value }))}
                    onChoice={(value) => setChoiceFilters((current) => ({ ...current, [column.id]: value }))}
                    scrollRoot={scrollRef}
                  />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => {
            const extra = detail?.(row) ?? null;
            return (
              <Fragment key={rowKey(row)}>
                <tr className="hover:bg-gray-50/70">
                  {columns.map((column) => (
                    <td key={column.id} className="border-b border-gray-100 px-4 py-3 align-top text-gray-600">
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {extra ? (
                  <tr>
                    <td colSpan={columns.length} className="border-b border-gray-100 bg-gray-50/70 p-0">
                      {extra}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {filtered.length === 0 && <p className="muted p-8 text-center text-sm">{empty}</p>}
    </div>
  );
}

function ColumnFilterControl<T>({
  column,
  rows,
  open,
  active,
  textValue,
  selected,
  onToggle,
  onClose,
  onText,
  onChoice,
  scrollRoot,
}: {
  column: FilterColumn<T>;
  rows: T[];
  open: boolean;
  active: boolean;
  textValue: string;
  selected: string[];
  onToggle: () => void;
  onClose: () => void;
  onText: (value: string) => void;
  onChoice: (value: string[]) => void;
  scrollRoot: RefObject<HTMLDivElement>;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const choices = useMemo(() => {
    if (column.kind !== "choice") return [];
    if (column.choices?.length) return [...column.choices];
    const seen = new Set<string>();
    for (const row of rows) {
      const value = column.text(row).trim();
      if (value) seen.add(value);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [column, rows]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 240;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const top = rect.bottom + 6;
      setPos((current) => (current && current.top === top && current.left === left ? current : { top, left }));
    };
    place();
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const scroller = scrollRoot.current;
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    scroller?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      scroller?.removeEventListener("scroll", place);
    };
  }, [open, scrollRoot]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Filter ${column.label}`}
        aria-expanded={open}
        data-active={active ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        className={clsx(
          "inline-flex h-5 w-5 items-center justify-center rounded-md",
          active ? "bg-gray-900 text-white" : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        )}
      >
        <Filter size={12} />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={`Filter ${column.label}`}
          className="fixed z-50 w-60 rounded-xl border border-gray-200 bg-white p-3 text-left normal-case tracking-normal shadow-card"
          style={{ top: pos.top, left: pos.left }}
        >
          {column.kind === "text" ? (
            <input
              autoFocus
              value={textValue}
              onChange={(event) => onText(event.target.value)}
              placeholder="Contains…"
              className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400"
            />
          ) : (
            <div className="max-h-48 space-y-1 overflow-auto">
              {choices.length === 0 && <p className="text-sm font-normal text-gray-500">No values</p>}
              {choices.map((choice) => (
                <label key={choice} className="flex items-center gap-2 text-sm font-normal text-gray-800">
                  <input
                    type="checkbox"
                    checked={selected.includes(choice)}
                    onChange={() => {
                      const next = selected.includes(choice)
                        ? selected.filter((item) => item !== choice)
                        : [...selected, choice];
                      onChoice(next);
                    }}
                  />
                  <span>{choice}</span>
                </label>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => (column.kind === "text" ? onText("") : onChoice([]))}
            className="mt-2 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            Clear
          </button>
        </div>
      )}
    </>
  );
}
