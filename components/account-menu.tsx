"use client";

import { useState } from "react";
import { User } from "lucide-react";
import { clsx } from "clsx";
import { useAccount } from "@/components/account-provider";

export function AccountMenu() {
  const { account, setLiveSync } = useAccount();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleLive = async () => {
    if (!account.configured || pending) return;
    setPending(true);
    setError(null);
    const ok = await setLiveSync(!account.liveSync);
    if (!ok) setError("Live data could not be changed.");
    setPending(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Account"
        title="Account"
        className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
      >
        <User size={18} />
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-gray-900/30 px-4 pt-16">
          <button className="absolute inset-0" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-md rounded-2xl bg-white p-5 shadow-xl ring-1 ring-gray-200">
            <h2 className="text-base font-semibold">Account</h2>
            <div className="mt-4 space-y-3">
              <section className="rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-200/70">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">AWS Key</p>
                {account.configured ? (
                  <p className="mt-2 text-sm text-gray-700">
                    Loaded from .env.local · key ending {account.keyHint} · {account.region}
                  </p>
                ) : (
                  <p className="mt-2 text-sm leading-relaxed text-gray-500">
                    Add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION to .env.local. Temporary keys that start with ASIA also need AWS_SESSION_TOKEN. Restart the server after you save the file.
                  </p>
                )}
              </section>
              <section className="flex items-center justify-between gap-4 rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-200/70">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Live Data</p>
                  <p className="mt-2 text-sm leading-relaxed text-gray-500">
                    {account.configured
                      ? "Refreshes Users and Resources every minute."
                      : "Add AWS keys before live data can refresh."}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Live Data"
                  aria-checked={account.liveSync}
                  disabled={!account.configured || pending}
                  onClick={toggleLive}
                  className={clsx(
                    "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40",
                    account.liveSync ? "bg-gray-900" : "bg-gray-300"
                  )}
                >
                  <span
                    className={clsx(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white transition",
                      account.liveSync ? "left-5" : "left-0.5"
                    )}
                  />
                </button>
              </section>
              {error && <p className="text-sm text-rose-700">{error}</p>}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
