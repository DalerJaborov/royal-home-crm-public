import { api, newIdempotencyKey } from "./api";
import { ApiError, isInProgressError } from "./apiError";

/**
 * ОТПРАВКА КЛИЕНТУ — ОДНА ДВЕРЬ С КЛЮЧОМ ПОВТОРА (17.11.2026, аудит F2-4).
 *
 * Как рождался дубль. Агент на мобильном интернете жмёт «Отправить»; сервер
 * сообщение уже отправил, но ответ теряется (таймаут 30 с, lib/api.ts). Сайт
 * пишет «Связь пропала — попробуем ещё раз», агент жмёт ещё раз — и клиент в
 * WhatsApp/Instagram получает два одинаковых сообщения (две подборки, два СМС,
 * два шаблона WhatsApp). Сервер защиту умеет давно (`idempotencyGuard`,
 * apps/api/src/lib/idempotency.ts: повтор с тем же заголовком `Idempotency-Key`
 * получает сохранённый ответ, второй раз ничего не уходит), но ни одна отправка
 * клиенту ключа не передавала.
 *
 * Один ключ — одно намерение:
 *  - повтор ТОГО ЖЕ (тот же адрес и то же содержимое), пока сервер не ответил
 *    (обрыв, таймаут, «ещё выполняется»), идёт с тем же ключом;
 *  - другое содержимое (агент поправил текст) — новый ключ: иначе сервер отдал бы
 *    ответ первой попытки, и исправленный текст молча не ушёл бы;
 *  - сервер ответил (успех или отказ по сути) — ключ сброшен: следующее нажатие
 *    это новое намерение, даже с тем же текстом.
 *
 * Все отправки клиенту идут через `sendToClient`; сторож
 * `lib/__tests__/clientSendGuard.test.ts` не пускает прямой `api(…, POST)` на эти
 * адреса мимо неё.
 */
export class SendIntent {
  /**
   * Ключ на каждое неотвеченное содержимое отдельно: агент может отправить «А»,
   * не дождавшись ответа отправить «Б», а потом повторить «А» — у «А» должен
   * остаться свой ключ, и ответ на «Б» не должен его стирать.
   */
  private pending = new Map<string, string>();
  private static readonly LIMIT = 20;

  keyFor(fingerprint: string): string {
    let key = this.pending.get(fingerprint);
    if (!key) {
      key = newIdempotencyKey();
      this.pending.set(fingerprint, key);
      // Предохранитель от роста: самые старые неотвеченные забываются первыми.
      if (this.pending.size > SendIntent.LIMIT) this.pending.delete(this.pending.keys().next().value!);
    }
    return key;
  }

  /** Звать с результатом попытки: сбрасывает ключ этого содержимого, если сервер ответил по сути. */
  settle(fingerprint: string, err?: unknown): void {
    // 409 inProgress: первая попытка ещё идёт — ключ держим, иначе следующее
    // нажатие обойдёт защиту новым ключом.
    if (isInProgressError(err)) return;
    if (err === undefined || err instanceof ApiError) this.pending.delete(fingerprint);
  }
}

/**
 * Отпечаток содержимого отправки: одинаковый для повтора того же, разный для другого.
 *
 * Файл (голосовое, фото) — по имени, размеру и типу, а не по объекту:
 * `FormData.append(name, blob, filename)` каждый раз заворачивает запись в НОВЫЙ
 * объект File, и сравнение объектов давало бы новый ключ на каждый повтор.
 * Совпадение размера у двух разных записей опасно только пока первая осталась
 * без ответа сервера — ключ живёт ровно это время.
 */
export function sendFingerprint(path: string, body: unknown): string {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((value, name) => {
      parts.push(`${name}=${typeof value === "string" ? value : `file:${value.name}:${value.size}:${value.type}`}`);
    });
    return `${path}\n${parts.join("&")}`;
  }
  return `${path}\n${JSON.stringify(body ?? null)}`;
}

/** POST-отправка клиенту с ключом повтора на намерение. */
export async function sendToClient<T>(intent: SendIntent, path: string, body?: unknown): Promise<T> {
  const fingerprint = sendFingerprint(path, body);
  const idempotencyKey = intent.keyFor(fingerprint);
  try {
    const result = await api<T>(path, { method: "POST", body, idempotencyKey });
    intent.settle(fingerprint);
    return result;
  } catch (err) {
    intent.settle(fingerprint, err);
    throw err;
  }
}
