/**
 * КТО НА САМОМ ДЕЛЕ БЕРЁТ ВХОДЯЩИЙ: КОНСУЛЬТАНТ ИЛИ ПРЕЖНИЕ ПРАВИЛА (28.09.2026).
 *
 * Разбор жалобы владельца «меняю одно — молча выключается другое». Режим
 * консультанта (Бот → Живой голос → «Когда консультант берёт трубку») на станции
 * ЗАМЕНЯЕТ часть правил из «Каналы связи → Телефония» (ops/asterisk/
 * extensions_custom.conf, `royalhome-inbound`):
 *
 *  - ночное правило (`nightaction`) и «Если оператор не ответил» (`action`,
 *    `seconds`, `phone`) не читаются вовсе — вместо них консультант;
 *  - в режиме «всегда» не звонят ни очередь, ни прямой аппарат
 *    («Куда идёт входящий звонок»): звонок сразу у консультанта.
 *
 * Но заменяет ТОЛЬКО если консультанта реально можно позвать: сервер без адреса
 * звука кладёт станции пустой режим, станция со старым диалпланом его не читает —
 * и тогда прежние правила продолжают действовать. Поэтому состояний три, а не два,
 * и экран обязан различать их, чтобы не говорить неправду ни в одну сторону.
 */
export type ConsultantInboundState =
  /** Консультант не выбран — правила Телефонии действуют как написано. */
  | "off"
  /** Выбран, сервер и станция готовы (или станцию ещё не проверяли) — правила Телефонии спят. */
  | "active"
  /** Выбран, но не работает (нет адреса звука на сервере или станция без ветки консультанта). */
  | "blocked";

export interface ConsultantInboundInput {
  liveVoiceEnabled?: boolean | null;
  liveVoiceInboundMode?: "off" | "no_answer" | "always" | null;
  liveVoiceInbound?: {
    rtpHostConfigured: boolean;
    stationDialplan: { ok: boolean | null } | null;
  };
}

export function consultantInboundState(settings: ConsultantInboundInput | null | undefined): ConsultantInboundState {
  const mode = settings?.liveVoiceInboundMode ?? "off";
  if (!settings?.liveVoiceEnabled || mode === "off") return "off";
  const status = settings.liveVoiceInbound;
  if (status && !status.rtpHostConfigured) return "blocked";
  if (status?.stationDialplan?.ok === false) return "blocked";
  return "active";
}

/** Текст пометки над правилом, которое консультант отменяет. */
export const CONSULTANT_OVERRIDES_NOTE =
  "Сейчас не действует: трубку берёт консультант (Бот → Живой голос). Настройка сохранена и вернётся в работу, если консультанта выключить.";

export const CONSULTANT_BLOCKED_NOTE =
  "В «Бот → Живой голос» выбран консультант, но он пока не может брать трубку (причина там же) — поэтому это правило сейчас действует.";
