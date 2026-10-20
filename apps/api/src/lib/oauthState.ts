import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

/**
 * STATE ДЛЯ CONSENT-FLOW КАНАЛОВ (вынесено из routes/tiktok.ts 23.09.2026, когда
 * появился второй канал с той же схемой — Threads, routes/threads.ts).
 *
 * Подписанная строка `<ts>.<nonce>.<hmac>` на HMAC-SHA256 от того же секрета,
 * которым подписываются access-токены (JWT_ACCESS_SECRET, см. auth/jwt.ts) —
 * переживает перезапуск процесса между нажатием кнопки «Подключить» и возвратом
 * из площадки, не требует отдельной таблицы или карты в памяти (в отличие от
 * routes/ads.ts). Один и тот же state годится для любого канала: площадка
 * возвращает его как есть, а какому каналу он принадлежит, решает путь колбэка
 * (`/api/v1/tiktok/oauth/callback` vs `/api/v1/threads/oauth/callback`), не
 * содержимое state.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  // Тот же секрет, что подписывает access-токены (auth/jwt.ts) — отдельного
  // секрета под OAuth state заводить не стали: значение никогда не покидает
  // сервер расшифрованным и не хранится, только сверяется.
  return process.env.JWT_ACCESS_SECRET ?? "";
}

export function signState(): string {
  const ts = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const payload = `${ts}.${nonce}`;
  const hmac = createHmac("sha256", stateSecret()).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyState(state: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [tsRaw, nonce, hmac] = parts;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS || Date.now() < ts) return false;
  const expected = createHmac("sha256", stateSecret()).update(`${tsRaw}.${nonce}`).digest("hex");
  const a = Buffer.from(hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
