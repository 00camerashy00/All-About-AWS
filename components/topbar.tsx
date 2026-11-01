"use client";

import Link from "next/link";
import { Bell, Menu } from "lucide-react";
import { useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { useAccount } from "@/components/account-provider";

export function Topbar() {
  const [open, setOpen] = useState(false);
  const { account } = useAccount();
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
        <div className="hidden items-center gap-2 lg:flex">
          <span className="rounded-full bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200">
            {account.configured ? account.region : "Demo data"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
          <Link
            href="/overview"
            onClick={() => setOpen(false)}
            className="block rounded-xl bg-gray-900 px-3 py-2.5 text-sm font-medium text-white"
          >
            Overview
          </Link>
          <Link
            href="/resources"
            onClick={() => setOpen(false)}
            className="block rounded-xl bg-gray-50 px-3 py-2.5 text-sm font-medium text-gray-700"
          >
            Resources
          </Link>
          <Link
            href="/users"
            onClick={() => setOpen(false)}
            className="block rounded-xl bg-gray-50 px-3 py-2.5 text-sm font-medium text-gray-700"
          >
            Users
          </Link>
          <Link
            href="/monitoring"
            onClick={() => setOpen(false)}
            className="block rounded-xl bg-gray-50 px-3 py-2.5 text-sm font-medium text-gray-700"
          >
            Monitoring
          </Link>
          <Link
            href="/alarms"
            onClick={() => setOpen(false)}
            className="block rounded-xl bg-gray-50 px-3 py-2.5 text-sm font-medium text-gray-700"
          >
            Alarms
          </Link>
        </nav>
      )}
    </header>
  );
}
