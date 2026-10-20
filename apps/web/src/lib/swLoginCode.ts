/**
 * Пуш с кодом входа (19.10.2026): код сначала уходит уведомлением на уже
 * вошедший телефон с приложением. Сервер ждёт подтверждения доставки 10 секунд
 * и, если его нет, сам шлёт СМС — поэтому воркер обязан сразу, не дожидаясь
 * нажатия, отчитаться на `/auth/login/code-ack`.
 *
 * Вынесено из `sw.ts` отдельным модулем, чтобы обработчик проверялся тестом
 * (сам воркер в vitest не поднять). Модуль без побочных эффектов и без обращения
 * к `self`: всё нужное приходит аргументами.
 */

export interface LoginCodePush {
  kind: "login-code";
  code: string;
  ackToken: string;
  title: string;
  body: string;
  tag?: string;
}

export function isLoginCodePush(v: unknown): v is LoginCodePush {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.kind === "login-code" && typeof o.ackToken === "string" && typeof o.title === "string" && typeof o.body === "string";
}

export interface LoginCodeRegistration {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
  pushManager: { getSubscription(): Promise<{ endpoint: string } | null> };
}

/**
 * Показать уведомление И отчитаться о доставке — одновременно. Отказ ack (нет
 * связи, 4xx) не должен мешать показу, поэтому его ошибки глотаем: тогда сервер
 * просто пришлёт СМС по истечении времени.
 */
export async function handleLoginCodePush(
  payload: LoginCodePush,
  registration: LoginCodeRegistration,
  doFetch: typeof fetch = fetch,
): Promise<void> {
  const show = registration.showNotification(payload.title, {
    body: payload.body,
    // Один слот: новый код заменяет старый и звучит снова.
    tag: "login-code",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Не ведём на чужой экран: клик открывает только вход.
    data: { url: "/login" },
  } as NotificationOptions);

  const ack = (async () => {
    try {
      const sub = await registration.pushManager.getSubscription();
      await doFetch("/api/v1/auth/login/code-ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ackToken: payload.ackToken, endpoint: sub?.endpoint }),
      });
    } catch {
      // см. комментарий выше
    }
  })();

  await Promise.allSettled([show, ack]);
}
