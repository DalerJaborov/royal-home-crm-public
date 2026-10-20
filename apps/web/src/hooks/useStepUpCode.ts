import { useCallback, useState } from "react";
import { api } from "../lib/api";
import { fallbackDeadline, type DeliveryChannel } from "../lib/codeDelivery";

/**
 * Подтверждение личности кодом (СМС, запасной канал — Telegram), когда у
 * сотрудника не включена двухфакторная защита. Пароля в системе больше нет
 * (19.10.2026): `GET /auth/step-up` отвечает `method: "totp" | "code"`, для
 * `"code"` код высылает `POST /auth/step-up/send-code`, а проверяет тот же
 * `POST /auth/step-up { code }`, что и для кода из приложения.
 *
 * Общий для StepUpGate (замок раздела) и StepUpDialog (окно перед действием).
 */

export type StepUpMethod = "totp" | "code";

interface SendCodeResponse {
  channel: DeliveryChannel;
  /** Для channel "push": через сколько секунд сервер сам пришлёт СМС. */
  fallbackAfterSec?: number;
  phoneHint: string;
  resendAfterSec?: number;
  telegramAvailable: boolean;
  devCode?: string;
}

export interface StepUpCodeState {
  channel: DeliveryChannel;
  /** Момент (мс), когда сервер сам шлёт СМС после пуша; 0 — отсчёта нет. */
  fallbackAt: number;
  phoneHint: string | null;
  telegramAvailable: boolean;
  /** Момент (мс), раньше которого «Отправить ещё раз» недоступно. */
  resendAt: number;
  sending: boolean;
  sendError: string | null;
}

export function useStepUpCode(onDevCode?: (code: string) => void) {
  const [state, setState] = useState<StepUpCodeState>({
    channel: "sms",
    fallbackAt: 0,
    phoneHint: null,
    telegramAvailable: false,
    resendAt: 0,
    sending: false,
    sendError: null,
  });

  const send = useCallback(
    async (channel?: "sms" | "telegram") => {
      setState((s) => ({ ...s, sending: true, sendError: null }));
      try {
        const r = await api<SendCodeResponse>("/auth/step-up/send-code", {
          method: "POST",
          body: channel ? { channel } : {},
        });
        setState({
          channel: r.channel,
          fallbackAt: fallbackDeadline(r.channel, r.fallbackAfterSec, Date.now()),
          phoneHint: r.phoneHint,
          telegramAvailable: r.telegramAvailable,
          resendAt: Date.now() + (r.resendAfterSec ?? 60) * 1000,
          sending: false,
          sendError: null,
        });
        // devCode приходит только на локальном стенде.
        if (r.devCode) onDevCode?.(r.devCode);
      } catch (err) {
        const wait = (err as { resendAfterSec?: number } | null)?.resendAfterSec;
        setState((s) => ({
          ...s,
          resendAt: wait ? Date.now() + wait * 1000 : s.resendAt,
          sending: false,
          sendError: err instanceof Error ? err.message : "Не удалось отправить код",
        }));
      }
    },
    [onDevCode],
  );

  return { ...state, send };
}
