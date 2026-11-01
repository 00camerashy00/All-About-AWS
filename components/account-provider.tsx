"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export interface PublicAccount {
  configured: boolean;
  liveSync: boolean;
  region: string;
  keyHint: string;
  source: "env" | "session" | "none";
}

interface AccountContextValue {
  account: PublicAccount;
  ready: boolean;
  revision: number;
  saveKeys: (input: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  setLiveSync: (liveSync: boolean) => Promise<boolean>;
  clearKeys: () => Promise<void>;
}

const EMPTY: PublicAccount = {
  configured: false,
  liveSync: false,
  region: "ap-south-1",
  keyHint: "",
  source: "none",
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<PublicAccount>(EMPTY);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account")
      .then((r) => r.json())
      .then((json: PublicAccount) => {
        if (!cancelled) setAccount(json);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKeys = useCallback(
    async (input: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string }) => {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!res.ok) {
        return {
          ok: false as const,
          error: json.detail || "Couldn't check those keys with AWS. Try again.",
        };
      }
      setAccount(json as PublicAccount);
      return { ok: true as const };
    },
    []
  );

  const setLiveSync = useCallback(async (liveSync: boolean) => {
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ liveSync }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as PublicAccount;
    setAccount(json);
    if (liveSync) setRevision((n) => n + 1);
    return true;
  }, []);

  const clearKeys = useCallback(async () => {
    const res = await fetch("/api/account", { method: "DELETE" });
    if (!res.ok) return;
    setAccount((await res.json()) as PublicAccount);
  }, []);

  const value = useMemo(
    () => ({ account, ready, revision, saveKeys, setLiveSync, clearKeys }),
    [account, ready, revision, saveKeys, setLiveSync, clearKeys]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
