import type { Metadata } from "next";
import "./globals.css";
import { AccountProvider } from "@/components/account-provider";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export const metadata: Metadata = {
  title: "AWS Management Dashboard",
  description:
    "Simple, minimal AWS dashboard for resources, users, monitoring, and alarms.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AccountProvider>
          <div className="min-h-screen lg:flex">
            <Sidebar />
            <div className="min-w-0 flex-1">
              <Topbar />
              <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
                {children}
              </main>
            </div>
          </div>
        </AccountProvider>
      </body>
    </html>
  );
}
