/**
 * Payom (payom.tj) — СМС-шлюз Таджикистана, заменил OsonSMS 24.09.2026.
 * Спецификация: https://payom.tj/payom-api.yaml (OpenAPI 3.0, версия 1.0.0).
 *
 *   POST https://<хост>/api/message
 *     Authorization: Bearer <JWT из «Настройки API» кабинета>
 *     { telephone: "+992XXXXXXXXX", text, senderName, type: "SMS", webhookUrl? }
 *   201 → { id, deliveryStatus, configuration: { quantityByLength, operator }, ... }
 *
 *   GET https://<хост>/api/balance → { username, balance: "1500.0000", currency: "TJS" }
 *
 * Логина в запросах нет — только токен. Свободный текст разрешён юрлицам (наш
 * случай); отправка по шаблону не нужна и не сделана.
 *
 * Ошибки приходят в двух видах, оба проверены живым запросом 24.09:
 *   401 { code, message: "Invalid JWT Token" }
 *   403/422/… JSON-LD { "hydra:title", "hydra:description", violations? } —
 *     403 «Доступ запрещен: добавьте IP в белый список.» — самое частое на старте.
 *
 * Хоста два (Россия и Нидерланды), токен один на оба. Запасной берётся ТОЛЬКО
 * когда до основного не удалось даже соединиться: если запрос ушёл и ответ
 * просто не дождались, повтор на втором хосте мог бы отправить СМС дважды.
 *
 * Кода «не храни текст у себя», как у OsonSMS, у Payom нет: код входа лежит в
 * их журнале отправок. Живёт он 5 минут и одноразовый (lib/loginSmsCode.ts).
 */

export const PAYOM_HOSTS = ["gateway.payom.tj", "gateway-p22.payom.tj"] as const;
/** СМС — не то, ради чего вход может висеть минуту: ответ шлюза за 15 секунд или отказ. */
const TIMEOUT_MS = 15_000;

export interface PayomCredentials {
  token: string;
  sender: string;
}

export type ProviderSendResult =
  | { ok: true; messageId: string | null; parts: number | null; deliveryStatus: string | null }
  | { ok: false; error: string; failureOutcome?: "refused" | "unknown" };

/**
 * Статусы доставки из спецификации. Промежуточные ждут следующего вебхука,
 * остальные конечные; ACCEPTED у Payom тоже конечный («принято оператором»).
 */
export const PAYOM_PENDING_STATUSES = ["SERVICE_ACCEPTED", "SENT", "ENROUTE"] as const;
export const PAYOM_FINAL_STATUSES = [
  "DELIVERED",
  "UNDELIVERABLE",
  "ACCEPTED",
  "EXPIRED",
  "REVOKED",
  "DELETED",
  "REJECTED",
  "UNKNOWN",
] as const;
export const PAYOM_STATUSES = [...PAYOM_PENDING_STATUSES, ...PAYOM_FINAL_STATUSES] as const;
export type PayomDeliveryStatus = (typeof PAYOM_STATUSES)[number];
/** Конечные статусы, при которых человек СМС не получил. */
export const PAYOM_NOT_DELIVERED: readonly PayomDeliveryStatus[] = ["UNDELIVERABLE", "EXPIRED", "REVOKED", "DELETED", "REJECTED"];

/** Ошибки, при которых запрос точно не дошёл до сервера — безопасно повторить на другом хосте. */
const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function neverConnected(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  return !!cause?.code && NOT_CONNECTED_CODES.has(cause.code);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** Что человеку сказать по ответу — «HTTP 403» в журнале ему ничего не даст. */
export function describePayomFailure(status: number, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const violations = Array.isArray(b.violations)
    ? (b.violations as { propertyPath?: unknown; message?: unknown }[])
        .map((v) => [str(v.propertyPath), str(v.message)].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ")
    : undefined;
  const detail = violations || str(b["hydra:description"]) || str(b.detail) || str(b.message);

  let reason: string;
  if (status === 401) reason = "Payom не принял токен — вставьте заново токен из «Настройки API» кабинета payom.tj";
  else if (status === 403) reason = "Payom отказал в доступе (IP сервера CRM должен быть в белом списке кабинета)";
  else if (status === 402) reason = "на счёте Payom закончились деньги";
  else if (status === 422) reason = "Payom не принял СМС";
  else if (status === 400) reason = "Payom не разобрал запрос";
  else if (status >= 500) reason = `у Payom сбой (${status}), попробуйте позже`;
  else reason = `Payom ответил ${status}`;
  return detail ? `${reason}: ${detail}` : reason;
}

async function payomFetch(
  path: string,
  init: RequestInit,
  opts: { retryOnAnyNetworkError: boolean }
): Promise<{ ok: true; res: Response } | { ok: false; error: string; failureOutcome: "refused" | "unknown" }> {
  let lastError = "";
  let failureOutcome: "refused" | "unknown" = "unknown";
  for (const host of PAYOM_HOSTS) {
    try {
      const res = await fetch(`https://${host}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { ok: true, res };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      failureOutcome = neverConnected(err) ? "refused" : "unknown";
      if (!opts.retryOnAnyNetworkError && !neverConnected(err)) break;
    }
  }
  return { ok: false, error: `Payom недоступен: ${lastError}`, failureOutcome };
}

export async function payomSend(
  creds: PayomCredentials,
  /** 992XXXXXXXXX — как отдаёт toSmsPhone. */
  phone: string,
  text: string,
  opts: { webhookUrl?: string | null } = {}
): Promise<ProviderSendResult> {
  const body: Record<string, unknown> = { telephone: `+${phone}`, text, senderName: creds.sender, type: "SMS" };
  if (opts.webhookUrl) body.webhookUrl = opts.webhookUrl;
  const r = await payomFetch(
    "/api/message",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    { retryOnAnyNetworkError: false }
  );
  if (!r.ok) return r;
  const json = await readJson(r.res);
  const m = json as { id?: unknown; deliveryStatus?: unknown; configuration?: { quantityByLength?: unknown } } | null;
  if (r.res.status === 201 || (r.res.ok && typeof m?.id === "string")) {
    const parts = m?.configuration?.quantityByLength;
    return {
      ok: true,
      messageId: typeof m?.id === "string" ? m.id : null,
      parts: typeof parts === "number" ? parts : null,
      deliveryStatus: typeof m?.deliveryStatus === "string" ? m.deliveryStatus : null,
    };
  }
  return { ok: false, error: describePayomFailure(r.res.status, json), failureOutcome: r.res.status >= 500 ? "unknown" : "refused" };
}

export async function payomBalance(
  creds: Pick<PayomCredentials, "token">
): Promise<{ ok: true; balance: number; currency: string } | { ok: false; error: string }> {
  const r = await payomFetch(
    "/api/balance",
    { headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" } },
    { retryOnAnyNetworkError: true }
  );
  if (!r.ok) return r;
  const json = await readJson(r.res);
  const b = json as { balance?: unknown; currency?: unknown } | null;
  const balance = Number(b?.balance);
  if (r.res.ok && Number.isFinite(balance)) {
    return { ok: true, balance, currency: typeof b?.currency === "string" ? b.currency : "TJS" };
  }
  return { ok: false, error: describePayomFailure(r.res.status, json) };
}
