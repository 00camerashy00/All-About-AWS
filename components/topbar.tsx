"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { AccountMenu } from "@/components/account-menu";
import { useAccount } from "@/components/account-provider";

const links = [
  { href: "/overview", label: "Overview" },
  { href: "/users", label: "Users" },
  { href: "/resources", label: "Resources" },
];

function liveSource(pathname: string): string {
  if (pathname.startsWith("/users")) return "/api/users";
  if (pathname.startsWith("/alarms")) return "/api/alarms";
  if (pathname.startsWith("/monitoring")) return "/api/monitoring?service=ec2&window=7d";
  return "/api/resources";
}

export function Topbar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { account, revision } = useAccount();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!account.configured) {
      setLive(false);
      return;
    }
    let cancelled = false;
    const source = liveSource(pathname);
    const check = () => {
      fetch(source)
        .then((response) => response.json())
        .then((json: { live?: boolean }) => {
          if (!cancelled) setLive(Boolean(json?.live));
        })
        .catch(() => {
          if (!cancelled) setLive(false);
        });
    };
    check();
    const timer = window.setInterval(check, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [account.configured, pathname, revision]);

  return (
    <header className="sticky top-0 z-20 border-b border-gray-200/80 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <button
          className="rounded-lg p-2 hover:bg-gray-100 lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
        >
          <Menu size={20} />
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={clsx(
              "rounded-full px-3 py-1.5 text-xs font-semibold ring-1",
              account.configured && live
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-gray-100 text-gray-500 ring-gray-200"
            )}
          >
            {account.configured && live ? "Live AWS data" : "Demo data"}
          </span>
          <span
            title="Alerts are paused"
            className="relative cursor-not-allowed rounded-xl border border-gray-100 bg-gray-50 p-2.5 text-gray-300"
          >
            <Bell size={18} />
          </span>
          <AccountMenu />
        </div>
      </div>
      {open && (
        <nav className="space-y-1 border-t border-gray-100 bg-white p-3 lg:hidden">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={clsx(
                "block rounded-xl px-3 py-2.5 text-sm font-medium",
                pathname.startsWith(link.href)
                  ? "bg-gray-900 text-white"
                  : "bg-gray-50 text-gray-700"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
