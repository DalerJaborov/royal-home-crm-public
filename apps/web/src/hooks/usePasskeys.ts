import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { api } from "../lib/api";
import type { SessionAgent } from "../store/auth";

/**
 * Вход по отпечатку или лицу (passkey) на стороне браузера.
 *
 * Вся криптография — внутри устройства и браузера: библиотека только передаёт
 * задание от сервера в системный диалог («приложите палец») и возвращает подпись.
 * Ни отпечаток, ни лицо сюда не попадают и никуда не отправляются.
 *
 * Разбор устройства и безопасности — apps/api/src/lib/passkeys.ts.
 */

export interface PasskeyDevice {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Умеет ли этот браузер вообще работать с ключами. Старый Android/десктоп без
 *  датчика — не умеет, и предлагать там нечего. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/** Имя устройства из браузера: «iPhone», «Android», «Mac». Человеку достаточно,
 *  чтобы отличить свой телефон от ноутбука в списке. */
export function guessDeviceName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iphone|ipad/i.test(ua)) return "iPhone";
  if (/android/i.test(ua)) return "Телефон Android";
  if (/mac/i.test(ua)) return "Mac";
  return "Компьютер";
}

/** Отказ в системном диалоге (передумал, не тот палец) — не ошибка приложения. */
export function isPasskeyCancel(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

export function usePasskeys(enabled = true) {
  return useQuery<PasskeyDevice[]>({
    queryKey: ["passkeys"],
    queryFn: () => api<PasskeyDevice[]>("/me/passkeys"),
    enabled: enabled && passkeysSupported(),
  });
}

/** Привязать это устройство: системный диалог отпечатка → ключ сохранён. */
export function useAddPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceName?: string) => {
      const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/me/passkeys/options", {
        method: "POST",
      });
      const response = await startRegistration({ optionsJSON: options });
      return api<{ ok: true }>("/me/passkeys/confirm", {
        method: "POST",
        body: { response, deviceName },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
  });
}

export function useRemovePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/me/passkeys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
  });
}

export interface PasskeyLoginResult {
  accessToken: string;
  // Не своя копия формы: `role: string` шире настоящего Role, и расхождение
  // с AuthAgent на границе входа компилятор не ловил.
  agent: SessionAgent;
}

/** Умеет ли браузер показывать ключ прямо в подсказке поля ввода (conditional UI).
 *  Проверка асинхронная и своя, отдельно от passkeysSupported: сам WebAuthn умеют
 *  почти все, а подсказку в поле — Safari 16+, Chrome 108+ и их мобильные версии. */
export function passkeyAutofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return Promise.resolve(false);
  return browserSupportsWebAuthnAutofill().catch(() => false);
}

/**
 * Вход по ключу с экрана входа.
 *
 * Телефон в форме заполнять не нужно: устройство само знает, чей ключ хранит.
 * Отказ (человек передумал, приложил не тот палец) — не ошибка приложения, о нём
 * сообщаем спокойно и оставляем вход паролем.
 *
 * useBrowserAutofill — «тихий» режим: вместо того чтобы сразу открыть системное
 * окно, браузер ждёт, пока человек коснётся поля «Телефон», и предлагает ключ
 * прямо в подсказке над клавиатурой. Это основной способ входа на телефоне: одно
 * касание вместо трёх. Запрос в этом режиме висит в фоне, пока его не выберут,
 * не отменят или не начнут другую попытку — поэтому вызывать его нужно один раз
 * при открытии экрана и гасить при уходе с него.
 */
export async function loginWithPasskey(useBrowserAutofill = false): Promise<PasskeyLoginResult> {
  const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/auth/passkey/login/options", {
    method: "POST",
  });
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill });
  return api<PasskeyLoginResult>("/auth/passkey/login/verify", {
    method: "POST",
    body: { challenge: options.challenge, response },
  });
}
