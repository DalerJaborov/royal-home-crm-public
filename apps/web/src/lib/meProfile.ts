import type { PermissionId, Role, UiPreferences } from "@royal-home/shared";

export interface MyProfile {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: Role;
  /** Server #1123: read-only actors cannot persist settings or mutate CRM data. */
  readOnly?: boolean;
  avatarUrl: string | null;
  preferences: UiPreferences | null;
  totpEnabled: boolean;
  /** До какого момента агент сам выключил приём новых лидов. null — принимает. */
  leadsPausedUntil: string | null;
  /** Когда прошлая пауза закончилась — от неё считается «остыть». */
  leadsPausedEndedAt: string | null;
  /** Паузу поставил руководитель (24.09.2026) — снять её сам агент не может. */
  leadsPausedBy?: { fullName: string } | null;
  leadsPausedReason?: string | null;
  /** Заморожен руководителем: работает с текущими клиентами, новых не получает. */
  frozenAt: string | null;
  frozenReason: string | null;
  frozenReasonVoiceUrl?: string | null;
  frozenReasonVoiceTranscript?: string | null;
  /** Итоговые права с учётом персональных надстроек — считает сервер (см. routes/me.ts). */
  permissions: PermissionId[];
  /** Привязан ли личный Telegram-чат (01.09.2026, lib/telegramAgentLink.ts) —
   *  сейчас единственное применение: приём готового ролика от монтажёра. */
  telegramLinked: boolean;
  /** Объекты на проверке приходят в Telegram с кнопками решения (22.09.2026). */
  telegramModeration: boolean;
  /** Назначен ли этот агент монтажёром (Settings.videoMontajerAgentId) —
   *  14.09.2026: гейт для кнопки привязки Telegram в профиле, остальным роль не нужна. */
  isVideoMontajer: boolean;
  /** Наблюдатель монтажа (22.09.2026): копии передач монтажёру в личный Telegram.
   *  Включать может только ADMIN/DIRECTOR — сервер проверяет роль сам. */
  montageCopiesTelegram: boolean;
  /** Готовые ролики на проверку модератора в Telegram (25.09.2026) — тумблер,
   *  как у telegramModeration, только про клипы: properties.moderate или
   *  ADMIN/DIRECTOR — сервер проверяет право/роль сам. */
  clipReviewTelegram: boolean;
  /* Признаки оператора входящих (incomingOperator, telephonyButton) убраны
   * 18.08.2026: роль оператора отменена целиком, звонки идут прямо агентам.
   * Сервер их пока отдаёт — лишнее поле в ответе ничего не ломает. */
}
