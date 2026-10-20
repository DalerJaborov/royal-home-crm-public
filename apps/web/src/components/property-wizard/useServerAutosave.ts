import { useCallback, useEffect, useRef, useState } from "react";
import type { PropertyDraftView } from "@royal-home/shared";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth";
import { registerWork } from "../../lib/workGuard";
import { setDraftReminder } from "../../lib/draftReminder";
import {
  adoptPropertyDraftSession, ensurePropertyDraftSession, getPropertyDraftSession,
  isPropertyDraftSessionCurrent, propertyDraftSessionToken,
} from "../../lib/propertyDraftSession";
import { DraftAutosave, type WizardDraftStatus } from "./draftAutosave";
import { isWizardEmpty, type WizardValues } from "./types";

const AUTOSAVE_DELAY_MS = 6_000;
const RETRY_DELAY_MS = 10_000;

export function useServerAutosave(
  enabled: boolean,
  values: WizardValues,
  step: number,
  draftIdRef: React.MutableRefObject<string | null>,
) {
  const [status, setStatus] = useState<WizardDraftStatus>({ state: "local" });
  const mounted = useRef(true);
  const unregister = useRef<(() => void) | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<DraftAutosave | null>(null);
  const notifyRef = useRef<(status: WizardDraftStatus) => void>(() => undefined);
  const sessionToken = useRef(propertyDraftSessionToken());
  const requestEpoch = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  if (!controllerRef.current) {
    controllerRef.current = new DraftAutosave(async (snapshot, keepalive) => {
      const token = sessionToken.current;
      const epoch = requestEpoch.current;
      const draft = await ensurePropertyDraftSession();
      if (epoch !== requestEpoch.current || !isPropertyDraftSessionCurrent(token)) throw new Error("Сессия черновика изменилась");
      const res = await api<{ draft: PropertyDraftView }>("/properties/drafts/current", {
        method: "PUT",
        body: { ...snapshot, draftId: draft.id, revision: draft.revision },
        expectAgentId: useAuthStore.getState().agent?.id,
        ...(keepalive ? { keepalive: true } : {}),
      });
      if (epoch !== requestEpoch.current || !isPropertyDraftSessionCurrent(token)) throw new Error("Сессия черновика изменилась");
      adoptPropertyDraftSession({ draft: res.draft, revision: res.draft.revision });
      draftIdRef.current = res.draft.id;
      setDraftReminder(res.draft.media.length > 0 || Object.keys(res.draft.values ?? {}).length > 0);
      return res.draft;
    }, (next) => notifyRef.current(next));
  }
  const controller = controllerRef.current;
  const clearRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);
  const flush = useCallback(async (keepalive = false) => {
    clearRetry();
    await controller.flush(keepalive);
  }, [controller, clearRetry]);
  const retry = useCallback(() => { void flush().catch(() => undefined); }, [flush]);
  const cancel = useCallback(() => {
    controller.cancel();
    requestEpoch.current++;
    sessionToken.current = propertyDraftSessionToken();
    clearRetry();
    unregister.current?.();
    unregister.current = null;
  }, [controller, clearRetry]);
  notifyRef.current = (next) => {
    if (mounted.current) setStatus(next);
    if (next.state === "server") {
      unregister.current?.();
      unregister.current = null;
    } else if (next.state === "local" && next.message && enabledRef.current && mounted.current) {
      clearRetry();
      retryTimer.current = setTimeout(retry, RETRY_DELAY_MS);
    } else if (next.state === "error") {
      clearRetry();
      unregister.current?.();
      unregister.current = null;
    }
  };

  const previousStep = useRef(step);
  useEffect(() => {
    if (!enabled) return;
    const empty = isWizardEmpty(values);
    if (empty && !getPropertyDraftSession()?.draft) return;
    sessionToken.current = propertyDraftSessionToken();
    controller.stage({ values: empty ? {} : { ...values }, step });
    if (!unregister.current) {
      unregister.current = registerWork({
        id: "wizard-draft-autosave", label: "Черновик объекта: поля ещё не сохранены",
        blocksUnload: false, resume: retry, flush: () => { void flush(true).catch(() => undefined); },
      });
    }
    const changedStep = previousStep.current !== step;
    previousStep.current = step;
    if (changedStep) { retry(); return; }
    const timer = setTimeout(retry, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, values, step, controller, retry, flush]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAuthStore.subscribe(() => {
      if (!isPropertyDraftSessionCurrent(sessionToken.current)) cancel();
    });
    return () => {
      mounted.current = false;
      clearRetry();
      unsubscribe();
      void flush(true).catch(() => undefined).finally(() => {
        unregister.current?.(); unregister.current = null;
      });
    };
  }, [cancel, clearRetry, flush]);

  return { status, flush, retry, cancel };
}
