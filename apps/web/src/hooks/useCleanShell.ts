import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useMobileUx } from "./useMobileUx";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { agentMobilePreviewOverride, cleanShellAllowedOnDevice, localAgentPreviewAllowed, savedAgentMobilePreview, saveAgentMobilePreview } from "./shellDevicePolicy";

const KEY = "rh-shell";
const EVENT = "rh-shell-change";

/** A layout choice never grants permissions or bypasses the server switch. */
export function cleanShellEnabled(requested: boolean, mobile: boolean, agentId: string | undefined, serverEnabled = false, role?: string, agentPreview = false): boolean {
  return !!agentId && requested && cleanShellAllowedOnDevice(mobile, role, agentPreview) && serverEnabled;
}

export function cleanShellOverride(search: string): boolean | undefined {
  const value = new URLSearchParams(search).get("shell");
  return value === "clean" ? true : value === "legacy" ? false : undefined;
}

function snapshot(agentId: string | undefined) {
  // An unscoped preference may belong to the previous person on a shared computer.
  if (!agentId) return undefined;
  try {
    const value = window.localStorage.getItem(`${KEY}:${agentId}`);
    return value === "clean" ? true : value === "legacy" ? false : undefined;
  } catch { return undefined; }
}

function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(EVENT, notify);
  };
}

/** Role-aware shell selection per account. Explicit legacy remains an escape hatch. */
export function useCleanShellSelection(poll = false) {
  const { search } = useLocation();
  const agentId = useAuthStore((s) => s.agent?.id);
  const role = useAuthStore((s) => s.agent?.role);
  const mobile = useMobileUx();
  const savedPreview = useSyncExternalStore(subscribe, () => savedAgentMobilePreview(agentId), () => false);
  const previewOverride = agentMobilePreviewOverride(search);
  const localAgentPreview = role === "AGENT" && localAgentPreviewAllowed();
  const agentPreview = localAgentPreview && mobile && (previewOverride ?? savedPreview);
  const deviceAllowed = cleanShellAllowedOnDevice(mobile, role, agentPreview);
  const policy = useQuery({
    queryKey: ["ui-shell", agentId],
    queryFn: () => api<{ enabled: boolean }>("/ui-shell", { timeoutMs: 8_000 }),
    enabled: !!agentId && deviceAllowed,
    staleTime: 15_000,
    // Only AppLayout owns the rollback poll; page/component observers share
    // the result without starting another timer per card or form.
    // Monitor an established Clean shell for emergency OFF. A cold failure or
    // OFF stays legacy until an explicit retry/reload, preserving open forms.
    refetchInterval: poll && !!agentId && deviceAllowed
      ? (query) => query.state.data?.enabled === true ? 30_000 : false
      : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Fail closed to legacy when the policy cannot be obtained. Offline queries
    // must fail rather than stay paused forever behind the layout skeleton.
    networkMode: "always",
    retry: false,
    // Layout and page both observe this policy. Retrying an errored query when
    // the legacy page mounts would hide that page, unmount it and repeat forever.
    retryOnMount: false,
  });
  const saved = useSyncExternalStore(subscribe, () => snapshot(agentId), () => undefined);
  const override = cleanShellOverride(search);
  useEffect(() => {
    if (!localAgentPreview || !agentId || previewOverride === undefined || previewOverride === savedAgentMobilePreview(agentId)) return;
    try {
      saveAgentMobilePreview(agentId, previewOverride);
      window.dispatchEvent(new Event(EVENT));
    } catch { /* The explicit URL still works when session storage is unavailable. */ }
  }, [agentId, localAgentPreview, previewOverride]);
  useEffect(() => {
    if ((localAgentPreview && (previewOverride !== undefined || savedPreview)) || !agentId || override === undefined || override === snapshot(agentId)) return;
    try {
      window.localStorage.setItem(`${KEY}:${agentId}`, override ? "clean" : "legacy");
      window.dispatchEvent(new Event(EVENT));
    } catch { /* The URL still works when browser storage is unavailable. */ }
  }, [override, agentId, localAgentPreview, previewOverride, savedPreview]);
  // Preserve an established shell on transient errors to avoid discarding drafts.
  // The unaccepted agent phone preview fails closed on error; cold failure and
  // successful server off responses always remain legacy.
  const requested = agentPreview || (override ?? saved ?? true);
  const clean = cleanShellEnabled(requested, mobile, agentId, policy.data?.enabled === true && (!agentPreview || !policy.isError), role, agentPreview);
  return {
    clean,
    // Do not mount working legacy controls only to discard them milliseconds
    // later when the first policy response chooses Clean.
    pending: !!agentId && deviceAllowed && requested && policy.isPending,
    ...(!!agentId && deviceAllowed && requested && policy.isError && !clean ? { unavailable: true } : {}),
  };
}

export function useCleanShell(): boolean {
  return useCleanShellSelection().clean;
}
