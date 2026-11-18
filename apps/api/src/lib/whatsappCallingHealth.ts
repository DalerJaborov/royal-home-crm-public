// СТОРОЖ «ЗВОНКИ WHATSAPP НЕ ДОХОДЯТ ДО СТАНЦИИ» (18.11.2026).
//
// Голосовые звонки клиентов в WhatsApp Meta отдаёт нашему шлюзу SIP
// (ops/whatsapp-gateway/, docs/whatsapp-calling-runbook.md). Сломаться это может
// на стороне Meta без единого сигнала у нас: номер теряет право на звонки, у
// приложения отзывают разрешение, кабинет блокируют — и клиент просто не
// дозванивается, а CRM видит «звонков нет». Meta сама говорит, готов ли номер
// принимать звонки через SIP:
//
// ФАКТ (developers.facebook.com/docs/whatsapp/cloud-api/health-status, 18.11.2026):
// `GET /{phone-number-id}?fields=health_status` → `health_status.entities[]`; у
// сущностей `PHONE_NUMBER` и `APP` есть `can_receive_call_sip` = AVAILABLE |
// LIMITED | BLOCKED; при BLOCKED — `errors[]` (`error_code`, `error_description`,
// `possible_solution`), при LIMITED — `additional_info[]`.
// ФАКТ (…/calling/sip): `GET /{phone-number-id}/settings` → `calling.status` и
// `calling.sip.status` (ENABLED / DISABLED).
//
// ЧТО ДЕЛАЕТ (раз в час, только чтение Graph):
//  - звонки или SIP у номера выключены — ничего: это решение владельца, не поломка;
//  - включены, а `can_receive_call_sip` у PHONE_NUMBER не AVAILABLE — тревога в
//    «Здоровье системы» с кодом и описанием Meta; одна открытая запись на
//    поломку, пока не станет AVAILABLE — тогда запись закрывается сама;
//  - сам запрос к Graph не прошёл (сеть, маркер, 4xx/5xx) — своя тревога, тоже
//    одна на поломку и тоже гаснет при первом удачном ответе.
// Маркер идёт заголовком Authorization, в адрес и в текст ошибок не попадает.
import { prisma } from "../db.js";
import { GRAPH_VERSION, isMetaChannelEnabled, loadCredentials } from "../messengers/meta.js";
import { resolveIncomingAccount } from "../messengers/accounts.js";
import { logSystemError } from "./systemError.js";

const FETCH_TIMEOUT_MS = 20_000;
export const WA_CALLING_SIP_ALARM_KEY = "whatsapp-calling-sip-unavailable";
export const WA_CALLING_CHECK_ALARM_KEY = "whatsapp-calling-health-check-failed";

/** Запрос к Graph: подменяется в тестах. Маркер — только заголовком. */
export type CallingGraphGet = (url: string, token: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultGet: CallingGraphGet = (url, token) =>
  fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export interface WhatsappCallingHealthResult {
  skipped: "channel_off" | "not_configured" | "calling_off" | null;
  /** Значение can_receive_call_sip у номера; null — не дошли до проверки. */
  sipAvailability: string | null;
  alarmed: boolean;
  /** Сам запрос к Graph не удался. */
  checkFailed: boolean;
}

interface GraphErrorBody {
  error?: { code?: number; message?: string };
}

class GraphCheckError extends Error {}

async function graphJson<T>(get: CallingGraphGet, path: string, token: string, what: string): Promise<T> {
  let res: Awaited<ReturnType<CallingGraphGet>>;
  try {
    res = await get(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, token);
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GraphCheckError(`${what}: Meta не ответила${timeout ? ` за ${FETCH_TIMEOUT_MS / 1000} с` : " (сеть)"}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GraphCheckError(`${what}: ответ Meta не читается (HTTP ${res.status})`);
  }
  const error = (body as GraphErrorBody | null)?.error;
  if (!res.ok || error) {
    // Текст Meta про маркер и права — без самого маркера; обрезаем на всякий случай.
    const detail = error?.message ? `: ${String(error.message).slice(0, 200)}` : "";
    throw new GraphCheckError(`${what}: HTTP ${res.status}, код Meta ${error?.code ?? "?"}${detail}`);
  }
  return body as T;
}

interface SettingsBody {
  calling?: { status?: string; sip?: { status?: string } };
}

interface HealthEntity {
  entity_type?: string;
  can_receive_call_sip?: string;
  errors?: { error_code?: number | string; error_description?: string; possible_solution?: string }[];
  additional_info?: string[];
}

interface HealthBody {
  health_status?: { entities?: HealthEntity[] };
}

/** Закрыть открытые тревоги с этим ключом (повторная проверка показала, что всё хорошо). */
async function resolveAlarm(dedupKey: string): Promise<void> {
  await prisma.errorLog.updateMany({
    where: { source: "meta", dedupKey, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
}

/**
 * Поднять тревогу, если открытой с тем же ключом ещё нет. Окно дедупликации
 * logSystemError (10 минут) при часовой проверке не спасает от строки в час,
 * поэтому повтор отсекается открытой записью: одна поломка — одна строка,
 * разобрали руками, а поломка осталась — через час появится снова.
 */
async function raiseAlarm(dedupKey: string, message: string): Promise<void> {
  const open = await prisma.errorLog.findFirst({ where: { source: "meta", dedupKey, resolvedAt: null }, select: { id: true } });
  if (open) return;
  await logSystemError("meta", message, { dedupKey });
}

function describeBlock(entity: HealthEntity): string {
  const errors = (entity.errors ?? [])
    .map((e) =>
      [e.error_code !== undefined ? `код ${e.error_code}` : null, e.error_description, e.possible_solution ? `что сделать: ${e.possible_solution}` : null]
        .filter(Boolean)
        .join(", ")
    )
    .filter(Boolean);
  const info = (entity.additional_info ?? []).filter((s) => typeof s === "string" && s.trim());
  const parts = [...errors, ...info].map((s) => s.slice(0, 300));
  return parts.length ? parts.join("; ") : "Meta причину не назвала";
}

/** Тик крона. Наружу бросает только сбой базы. */
export async function runWhatsappCallingHealthCheck(get: CallingGraphGet = defaultGet): Promise<WhatsappCallingHealthResult> {
  const result: WhatsappCallingHealthResult = { skipped: null, sipAvailability: null, alarmed: false, checkFailed: false };
  if (!(await isMetaChannelEnabled("WHATSAPP"))) return { ...result, skipped: "channel_off" };
  const creds = await loadCredentials();
  // Маркер номера — из «Каналов» (MessengerAccount), запасной — из Настроек; как у сторожа вебхука.
  const token = creds.waPhoneId ? (await resolveIncomingAccount("WHATSAPP", creds.waPhoneId)).token || creds.waToken : undefined;
  if (!creds.waPhoneId || !token) return { ...result, skipped: "not_configured" };
  const phoneId = encodeURIComponent(creds.waPhoneId);

  try {
    const settings = await graphJson<SettingsBody>(get, `${phoneId}/settings`, token, "Настройки звонков номера");
    const callingOn = settings.calling?.status === "ENABLED" && settings.calling?.sip?.status === "ENABLED";
    if (!callingOn) {
      // Выключено намеренно — не поломка. Прошлую тревогу о проверке гасим: Meta ответила.
      await resolveAlarm(WA_CALLING_CHECK_ALARM_KEY);
      return { ...result, skipped: "calling_off" };
    }
    const health = await graphJson<HealthBody>(get, `${phoneId}?fields=health_status`, token, "Состояние номера");
    await resolveAlarm(WA_CALLING_CHECK_ALARM_KEY);
    const phone = health.health_status?.entities?.find((e) => e.entity_type === "PHONE_NUMBER");
    const availability = phone?.can_receive_call_sip ?? null;
    result.sipAvailability = availability;
    if (availability === "AVAILABLE") {
      await resolveAlarm(WA_CALLING_SIP_ALARM_KEY);
      return result;
    }
    const state =
      availability === "BLOCKED" ? "заблокированы" : availability === "LIMITED" ? "ограничены" : `в неизвестном состоянии (${availability ?? "Meta не сообщила"})`;
    await raiseAlarm(
      WA_CALLING_SIP_ALARM_KEY,
      `Звонки WhatsApp на станцию ${state}: клиенты могут не дозвониться через WhatsApp. Meta: ${phone ? describeBlock(phone) : "номера нет в ответе о состоянии"}.`
    );
    result.alarmed = true;
    return result;
  } catch (err) {
    if (!(err instanceof GraphCheckError)) throw err;
    result.checkFailed = true;
    await raiseAlarm(WA_CALLING_CHECK_ALARM_KEY, `Не удалось проверить звонки WhatsApp. ${err.message}`);
    return result;
  }
}
