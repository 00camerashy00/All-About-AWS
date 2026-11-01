"use client";

import { useState } from "react";
import { User } from "lucide-react";
import { useAccount } from "@/components/account-provider";

export function AccountMenu() {
  const { account } = useAccount();
  const [open, setOpen] = useState(false);

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
          <div className="relative max-h-[calc(100vh-6rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl ring-1 ring-gray-200">
            <h2 className="text-base font-semibold">AWS access keys</h2>
            {account.configured ? (
              <>
                <p className="mt-1 text-sm text-gray-500">
                  Keys are read from <span className="font-medium text-gray-700">.env.local</span> on this server. They are not shown here. Nothing is read from AWS until you press Rescan on a page.
                </p>
                <p className="mt-3 text-sm text-gray-700">
                  Loaded from .env.local · key ending {account.keyHint} · {account.region}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-gray-500">
                Add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION to .env.local. Temporary keys that start with ASIA also need AWS_SESSION_TOKEN. Restart the server after you save the file.
              </p>
            )}
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
