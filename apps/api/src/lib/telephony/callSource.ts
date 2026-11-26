import type { IncomingCallSource } from "@royal-home/shared";
import { INCOMING_CALL_NOTE_PREFIX } from "../noContact.js";

/**
 * ОТКУДА ПРИШЁЛ ВХОДЯЩИЙ — ОДНА ДВЕРЬ (18.11.2026).
 *
 * Голосовые звонки клиентов в WhatsApp шлюз SIP (ops/whatsapp-gateway/) отдаёт на
 * станцию через PJSIP-аппарат `whatsapp-gw` (ops/asterisk/pjsip.endpoint_custom_post.conf).
 * Контекст `from-trunk-whatsapp` (ops/asterisk/extensions_custom.conf) приводит номер
 * к виду станции и уводит звонок в `ext-did` — дальше это обычный входящий. Отличить
 * его от звонка с линии можно только по имени канала: Asterisk называет его
 * `PJSIP/<аппарат>-<номер канала>`, то есть `PJSIP/whatsapp-gw-00000012`.
 *
 * Имя аппарата меняется только вместе с конфигом станции — поэтому оно здесь
 * одной константой, и все решения «это WhatsApp?» идут через функции ниже.
 */
export const WHATSAPP_GATEWAY_CHANNEL_PREFIX = "PJSIP/whatsapp-gw-";

/** Источник звонка по имени канала станции. Пустое/незнакомое имя — обычная линия. */
export function incomingCallSourceFromChannel(channelName: string | null | undefined): IncomingCallSource {
  return channelName?.startsWith(WHATSAPP_GATEWAY_CHANNEL_PREFIX) ? "whatsapp" : "phone";
}

/**
 * НА КАКОЙ НАШ НОМЕР WHATSAPP ЗВОНИЛИ (26.11.2026, второй номер — «Арван»).
 *
 * Звонок на основной номер шлюз набирает станции городским номером (6501414), на
 * любой другой — его phone_number_id у Meta (13–20 цифр; шлюз это проверяет —
 * ops/whatsapp-gateway/entrypoint.sh, станция ловит такие номера шаблоном —
 * ops/asterisk/extensions_custom.conf, [from-trunk-whatsapp]). Событие создания
 * канала несёт этот номер в `dialplan.exten`, пока станция ещё не увела звонок в
 * маршрут городского номера.
 *
 * Возвращает phone_number_id не основного номера, иначе null: основной номер,
 * обычная линия или канал, подхваченный досинхронизацией уже ПОСЛЕ перехода в
 * маршрут (тогда exten — 6501414 или номер очереди, бренд не узнать — звонок
 * пишется как на основной номер; это только при разрыве связи с станцией).
 */
const WHATSAPP_LINE_ID = /^\d{13,20}$/;
export function whatsappLineFromChannel(
  channel: { name?: string | null; dialplan?: { exten?: string | null } | null } | null | undefined
): string | null {
  if (incomingCallSourceFromChannel(channel?.name) !== "whatsapp") return null;
  const exten = channel?.dialplan?.exten ?? "";
  return WHATSAPP_LINE_ID.test(exten) ? exten : null;
}

/**
 * Откуда клиент, если карточку завёл звонок. WhatsApp-звонок — это канал WhatsApp
 * (`ClientSource.WHATSAPP`), а не телефонная линия: иначе отчёт по источникам
 * записал бы клиента из WhatsApp в «звонки».
 */
export function clientSourceForCall(source: string | null | undefined): "WHATSAPP" | "PHONE_CALL" {
  return source === "whatsapp" ? "WHATSAPP" : "PHONE_CALL";
}

/**
 * Начало записи о входящем в хронологии клиента.
 *
 * WhatsApp ДОПИСЫВАЕТСЯ ПОСЛЕ «Входящий звонок», а не заменяет его: по этому
 * началу текста два места понимают, что запись — о входящем:
 *  - lib/noContact.ts (`INCOMING_CALL_NOTE_PREFIX`) — пропущенный входящий,
 *    записанный от имени агента, не считается его контактом с клиентом;
 *  - lib/telephony/callRecordings.ts — у входящего файл записи ищется без
 *    добавочного агента (разговор пишет очередь).
 * «Звонок из WhatsApp: …» в начале строки молча сломал бы оба (сторож —
 * tests/whatsapp-call-source.test.ts).
 *
 * `ofClient` — вариант «Входящий звонок клиента…» (звонивший — клиент в базе).
 * `brand` — имя страницы не основного номера WhatsApp («Арван»): «…из WhatsApp (Арван)».
 */
export function inboundCallNotePrefix(source: string | null | undefined, ofClient: boolean, brand?: string | null): string {
  const base = ofClient ? `${INCOMING_CALL_NOTE_PREFIX} клиента` : INCOMING_CALL_NOTE_PREFIX;
  if (source !== "whatsapp") return base;
  const name = brand?.trim();
  return name ? `${base} из WhatsApp (${name})` : `${base} из WhatsApp`;
}
