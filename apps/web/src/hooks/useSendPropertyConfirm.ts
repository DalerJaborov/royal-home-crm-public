import { useState } from "react";

const STORAGE_KEY = "rh.matchSendConfirmed.v1";

function hasConfirmedBefore(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberConfirmed() {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* приватный режим/запрет доступа к хранилищу — просто спросим ещё раз в следующий раз */
  }
}

/**
 * Гейт перед «Отправить объект»/«В переписку»/«Отправить клиенту» (панель «Подбор»,
 * владелец 18.09.2026: агент нажимал кнопку не понимая, что она СРАЗУ шлёт реальное
 * сообщение клиенту в мессенджер и НАВСЕГДА глушит бота в этом диалоге — ни то, ни
 * другое нигде не объяснялось до клика).
 *
 * Спрашиваем только ПЕРВЫЙ раз на устройстве агента, дальше — не мешаем: эта кнопка
 * нажимается десятки раз в день, диалог на каждый клик превратился бы в шум, который
 * закрывают не глядя, а не в предупреждение. Один раз объяснили — дальше доверяем.
 */
export function useSendPropertyConfirm() {
  const [pending, setPending] = useState<{ run: () => void; description: string } | null>(null);

  function request(run: () => void, description: string) {
    if (hasConfirmedBefore()) {
      run();
      return;
    }
    setPending({ run, description });
  }

  function confirm() {
    rememberConfirmed();
    const run = pending?.run;
    setPending(null);
    run?.();
  }

  function cancel() {
    setPending(null);
  }

  return { open: pending !== null, description: pending?.description ?? "", request, confirm, cancel };
}
