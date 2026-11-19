import { z } from "zod";

/**
 * СОБЫТИЯ ЗВОНКОВ WHATSAPP В ВЕБХУКЕ (18.11.2026).
 *
 * Голос клиентов в WhatsApp идёт через шлюз SIP на станцию (docs/whatsapp-calling-runbook.md),
 * а Meta в тот же вебхук, что и сообщения, шлёт события звонков отдельным полем:
 * `entry[].changes[].field = "calls"`, внутри `value.calls[]`. До этой правки такие
 * изменения молча пропускались — ни строки в журнале контейнера.
 *
 * ФАКТ (developers.facebook.com/docs/whatsapp/cloud-api/calling/user-initiated-calls,
 * …/calling/sip, проверено 18.11.2026):
 *  - событие `connect` (у SIP — «call created», без SDP) и `terminate`;
 *  - поля звонка: `id` (WACID — тот же, что заголовок SIP `x-wa-meta-wacid`, который
 *    станция кладёт в `RH_WA_CALL_ID`), `from` (wa_id клиента), `to`, `event`,
 *    `timestamp`, `direction`; у `terminate` ещё `status` (COMPLETED / FAILED) и,
 *    если трубку сняли, `start_time`, `end_time`, `duration` (секунды);
 *  - `errors` в примере Meta лежит на уровне `value`, а в таблице полей — у звонка;
 *    читаем оба места;
 *  - статусы звонка, который начал БИЗНЕС (…/calling/business-initiated-calls), идут
 *    тем же полем `calls`, но в `value.statuses[]` (`type: "call"`, `status`
 *    RINGING / ACCEPTED / REJECTED, `recipient_id`). Сейчас мы сами не звоним, но
 *    такие статусы раньше попадали в разбор доставки сообщений
 *    (meta.ts::parseStatusUpdates) — теперь они там пропускаются, а здесь пишутся
 *    событием `status`.
 *
 * Здесь ТОЛЬКО разбор и одна строка в журнал. Звонок как таковой CRM видит со
 * стороны станции (lib/telephony/incomingCalls.ts) — второй записи о том же
 * звонке из вебхука не заводим; повторная доставка даёт лишь повтор строки лога,
 * то есть событие идемпотентно по природе. Номер клиента в лог не пишем целиком.
 */

const callErrorSchema = z
  .object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() })
  .passthrough();

const callSchema = z
  .object({
    id: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    event: z.string().optional(),
    status: z.string().optional(),
    direction: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    duration: z.union([z.number(), z.string()]).optional(),
    errors: z.union([z.array(callErrorSchema), callErrorSchema]).optional(),
  })
  .passthrough();

const callStatusSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    recipient_id: z.string().optional(),
    errors: z.array(callErrorSchema).optional(),
  })
  .passthrough();

const bodySchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: z
                      .object({
                        metadata: z.object({ phone_number_id: z.string().optional() }).passthrough().optional(),
                        calls: z.array(z.unknown()).optional(),
                        statuses: z.array(z.unknown()).optional(),
                        errors: z.array(callErrorSchema).optional(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

export interface WhatsappCallEvent {
  /** WACID — совпадает с заголовком SIP `x-wa-meta-wacid` / `RH_WA_CALL_ID` на станции. */
  callId: string | null;
  event: string | null;
  /** wa_id клиента (номер без «+»; у статуса — получатель). В лог — только маской. */
  from: string | null;
  status: string | null;
  direction: string | null;
  durationSec: number | null;
  /** Наш номер в Meta (phone_number_id), на который звонили. */
  phoneNumberId: string | null;
  errors: string[];
}

function describeErrors(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((e) => {
    const parsed = callErrorSchema.safeParse(e);
    if (!parsed.success) return [];
    const text = [parsed.data.code, parsed.data.message].filter((v) => v !== undefined && v !== "").join(" ");
    return text ? [text.slice(0, 200)] : [];
  });
}

/**
 * События звонков из тела вебхука WhatsApp. Никогда не бросает: кривое тело,
 * чужой продукт или изменение без звонков — пустой список.
 */
export function parseWhatsappCallEvents(body: unknown): WhatsappCallEvent[] {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== "whatsapp_business_account") return [];
  const out: WhatsappCallEvent[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "calls") continue;
      const value = change.value;
      const valueErrors = describeErrors(value?.errors);
      for (const rawCall of value?.calls ?? []) {
        const call = callSchema.safeParse(rawCall);
        if (!call.success) continue;
        const duration = Number(call.data.duration);
        out.push({
          callId: call.data.id ?? null,
          event: call.data.event ?? null,
          from: call.data.from ?? null,
          status: call.data.status ?? null,
          direction: call.data.direction ?? null,
          durationSec: call.data.duration !== undefined && Number.isFinite(duration) ? duration : null,
          phoneNumberId: value?.metadata?.phone_number_id ?? null,
          errors: [...describeErrors(call.data.errors), ...valueErrors],
        });
      }
      for (const rawStatus of value?.statuses ?? []) {
        const status = callStatusSchema.safeParse(rawStatus);
        if (!status.success) continue;
        out.push({
          callId: status.data.id ?? null,
          event: "status",
          from: status.data.recipient_id ?? null,
          status: status.data.status ?? null,
          direction: "BUSINESS_INITIATED",
          durationSec: null,
          phoneNumberId: value?.metadata?.phone_number_id ?? null,
          errors: [...describeErrors(status.data.errors), ...valueErrors],
        });
      }
    }
  }
  return out;
}

/** Маска wa_id для журнала контейнера: последние четыре цифры, как у номеров в журнале ошибок. */
function maskWaId(waId: string | null): string {
  if (!waId) return "<нет>";
  const digits = waId.replace(/\D/g, "");
  return digits.length > 4 ? `•••${digits.slice(-4)}` : "•••";
}

/** Одна строка в журнал контейнера на событие. Не пишет в базу и не бросает. */
export function logWhatsappCallEvent(event: WhatsappCallEvent, log: (line: string) => void = console.log): void {
  try {
    log(
      `[whatsapp-звонок] событие=${event.event ?? "?"} id=${event.callId ?? "?"} от=${maskWaId(event.from)}` +
        ` статус=${event.status ?? "-"} длительность=${event.durationSec ?? "-"}с направление=${event.direction ?? "-"}` +
        ` номер=${event.phoneNumberId ?? "-"}` +
        (event.errors.length ? ` ошибки=${event.errors.join("; ")}` : "")
    );
  } catch {
    // Журнал не должен ронять разбор вебхука.
  }
}

/** Разобрать тело вебхука и записать события звонков. Возвращает их число. */
export function handleWhatsappCallEvents(body: unknown, log?: (line: string) => void): number {
  const events = parseWhatsappCallEvents(body);
  for (const event of events) logWhatsappCallEvent(event, log);
  return events.length;
}
