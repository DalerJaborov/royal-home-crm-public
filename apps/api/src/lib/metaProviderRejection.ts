/**
 * «META ТОЧНО НЕ ПРИНЯЛА ОТПРАВКУ» — ОДНО ПРАВИЛО (25.11.2026, ревью #432). Раньше три копии одной регулярки
 * (`^Graph API HTTP 4xx`) решали «не ушло» в транспорте (messengers/meta.ts), в доставке карточки объекта
 * (lib/customerPropertyDelivery.ts) и в трассе хода (lib/botTurnTrace.ts). Отказ без запроса «доступ к аккаунту
 * Instagram потерян» под регулярку не подходил и считался «исход неизвестен».
 *
 * Модуль без импортов: его зовут и транспорт, и ядро, и трасса — круга импортов он не даёт.
 */

/** Ошибка «в Meta не ходили: у аккаунта Instagram отметка потери доступа» (lib/instagramAccountAccess.ts). Журнал её не пишет. */
export class InstagramAccessLostError extends Error {
  readonly instagramAccessLost = true;
  constructor(readonly accountId: string, reason: string | null) {
    super(`Instagram: доступ к аккаунту ${accountId} потерян (${(reason ?? "ключ не принят").slice(0, 120)}) — запрос в Meta не отправлен`);
    this.name = "InstagramAccessLostError";
  }
}

export function isInstagramAccessLostError(err: unknown): err is InstagramAccessLostError {
  return err instanceof InstagramAccessLostError ||
    (typeof err === "object" && err !== null && (err as { instagramAccessLost?: unknown }).instagramAccessLost === true);
}

/** Meta ответила отказом 4xx или запрос не делался из-за потери доступа — клиент точно ничего не получил. */
export function isProviderDefinitiveRejection(err: unknown): boolean {
  if (isInstagramAccessLostError(err)) return true;
  return err instanceof Error && /^Graph API HTTP 4\d\d:/.test(err.message);
}
