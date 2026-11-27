/**
 * «СВЕДЕНИЯ О КОНТАКТЕ» — чистые правила окна (макет C, 27.11.2026): какая кнопка главная и какие строки
 * идут в «Подробности». Без React, чтобы правило проверялось тестом, а не глазами.
 */

export type ContactPrimaryAction =
  | { kind: "accept"; label: "Принять заявку" }
  | { kind: "card"; label: "Открыть карточку клиента"; shortId: string }
  | null;

export interface ContactActionInput {
  clientId: string | null | undefined;
  clientShortId: string | null | undefined;
  /** Заявка ещё не принята (client.pendingAcceptance). */
  pendingAcceptance: boolean;
  /** Именно этот сотрудник может её принять: заявка закреплена за ним и аккаунт не «только чтение». */
  canAccept: boolean;
}

/**
 * ОДНА главная кнопка. «Принять заявку» — только пока она ждёт принятия и принять может смотрящий;
 * иначе — «Открыть карточку клиента»; нет карточки — главной кнопки нет (останется «Позвонить» и «Связать с клиентом»).
 */
export function contactPrimaryAction(input: ContactActionInput): ContactPrimaryAction {
  if (input.clientId && input.pendingAcceptance && input.canAccept) return { kind: "accept", label: "Принять заявку" };
  if (input.clientShortId) return { kind: "card", label: "Открыть карточку клиента", shortId: input.clientShortId };
  return null;
}

/** Две вторичные кнопки: «Позвонить» (есть номер и можно звонить) и «Карточка клиента» (если она не главная). */
export function contactSecondaryActions(input: ContactActionInput & { hasPhone: boolean; readOnly: boolean }): { call: boolean; card: boolean } {
  const primary = contactPrimaryAction(input);
  return {
    call: input.hasPhone && !input.readOnly,
    card: !!input.clientShortId && primary?.kind !== "card",
  };
}

export interface ContactDetailsInput {
  code: string | null;
  profileName: string | null;
  phone: string | null;
  /** Уже готовая подпись («2 дня назад»). */
  firstContact: string;
  messagesCount: number;
  subscriberId: string | null;
  /** Досье бота есть: тогда «Пишет нам с…», «всего сообщений» уже сказаны в блоке «Что знает бот». */
  hasDossier: boolean;
  isGroupedEntry: boolean;
}

export interface ContactDetailRow { key: string; label: string; value: string }

/**
 * Строки «Подробностей» БЕЗ повторов: канал уже назван под именем, а «первое обращение» и «число сообщений» при
 * наличии досье сказаны в «Что знает бот» теми же словами (раньше они стояли в окне дважды).
 */
export function contactDetailRows(input: ContactDetailsInput): ContactDetailRow[] {
  const rows: ContactDetailRow[] = [];
  if (input.code) rows.push({ key: "code", label: "Карточка", value: input.code });
  rows.push({ key: "phone", label: "Телефон", value: input.phone ?? "Номер пока не указан" });
  rows.push({ key: "profile", label: "Имя в профиле", value: input.profileName ?? "Не указано" });
  if (!input.hasDossier) {
    rows.push({ key: "first", label: "Первое обращение", value: input.firstContact });
    rows.push({ key: "count", label: "Сообщений", value: String(input.messagesCount) });
  }
  if (!input.isGroupedEntry && input.subscriberId) rows.push({ key: "subscriber", label: "Идентификатор в канале", value: input.subscriberId });
  return rows;
}
