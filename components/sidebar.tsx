"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import {
  LayoutDashboard,
  Link2,
  Server,
  Users,
  Cloud,
} from "lucide-react";

const links = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/users", label: "Users", icon: Users },
  { href: "/resources", label: "Resources", icon: Server },
  { href: "/secure-link", label: "Secure Link", icon: Link2 },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 border-r border-gray-200/80 bg-white lg:block">
      <div className="flex h-16 items-center gap-2 border-b border-gray-100 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gray-900 text-white">
          <Cloud size={18} />
        </span>
        <div>
          <p className="text-sm font-semibold leading-none">All About AWS</p>
          <p className="mt-1 text-xs text-gray-500">A Krishagni Project</p>
        </div>
      </div>
      <nav className="space-y-1 p-3">
        {links.map((l) => {
          const Icon = l.icon;
          const active = pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={clsx(
                "flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition",
                active
                  ? "bg-gray-900 text-white"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              )}
            >
              <Icon size={17} />
              {l.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
