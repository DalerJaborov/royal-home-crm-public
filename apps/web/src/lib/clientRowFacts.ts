import type { Client } from "../types";
import { dushanbeDate, dushanbeDayKey } from "./date";

/**
 * СТРОКА КЛИЕНТА ГОВОРИТ ТОЛЬКО ФАКТЫ (владелец 21.11.2026, кадры списка на телефоне).
 *
 * Дословно: «зачем там отметки, типа позвонить, давно не связывались и так далее? Как он
 * вообще это узнал? И почему написано, что с кем-то не связывались 54 дня, если реально
 * сегодня связывались? Таких ошибок чтобы не было вообще». До этого дня строка рисовала
 * советы: «позвонить» (жёлтый/красный — по сроку из хронологии), «первый звонок»,
 * «ответить», «Давно не связывались · дата» красным (по `lastContactAt`, который двигает
 * любая заметка, а у новой карточки равен моменту создания) и «Следующий шаг не назначен».
 * Светофор и статусы владелец снял ещё 17.11; про шаг: «зачем следующий шаг? он разве нужен».
 *
 * Теперь в строке ровно два факта, и оба отсюда (одно место для ПК, телефона и старого вида):
 *  - `clientRowFact` — метка «ждёт принятия», только если заявку правда не приняли;
 *  - `lastContactLabel` — «последний контакт ДД.ММ» по правилу контакта всей CRM
 *    (сервер, `lastStaffContactAt`: lib/noContact.ts), либо «контакта ещё не было».
 * Советов, сроков и цвета тревоги в строке нет. Сторож — clientRowFacts.test.ts.
 */

type FactInput = Pick<Client, "kind" | "status" | "pendingAcceptance" | "deletedAt" | "hiddenReason">;

export interface ClientRowFact {
  id: "waiting";
  label: string;
}

export function clientRowFact(c: FactInput): ClientRowFact | null {
  // Не назначается агенту, в корзине или скрыт: у такой карточки своя отметка (clientPrimaryState).
  if (c.kind === "OTHER" || c.deletedAt || c.hiddenReason) return null;
  if (["LOST", "ARCHIVED", "DEAL_CLOSED"].includes(c.status)) return null;
  return c.pendingAcceptance ? { id: "waiting", label: "ждёт принятия" } : null;
}

/**
 * Подпись последнего контакта. `undefined` — сервер дату не прислал (карточка ещё не
 * ваша, старый ответ): подписи нет вовсе, а не выдумка. `null` — сотрудники с клиентом
 * ни разу не связывались по общему правилу.
 */
export function lastContactLabel(at: string | null | undefined, now: Date = new Date()): string | null {
  if (at === undefined) return null;
  if (at === null) return "контакта ещё не было";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = dushanbeDayKey(d).slice(0, 4) === dushanbeDayKey(now).slice(0, 4);
  return `последний контакт ${dushanbeDate(d, sameYear ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" })}`;
}
