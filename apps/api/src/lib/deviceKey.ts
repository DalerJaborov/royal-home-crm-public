import type { Request } from "express";
import { parseDevice } from "./device.js";

/**
 * Ключ устройства для Session/LoginLog. Предпочитаем случайный id, который клиент
 * сам генерирует и хранит в localStorage (см. lib/api.ts на фронтенде, заголовок
 * X-Device-Id) — иначе две РАЗНЫЕ физические машины с одинаковым браузером+ОС
 * (частый случай в маленьком офисе на одинаковых Windows-компьютерах) схлопывались
 * бы в одну запись Session, что тихо ломало и лимит на 3 устройства, и алерт
 * «вход с нового устройства» (deviceKey совпадал бы с уже известным чужим устройством).
 * UA-эвристика — резервный вариант для клиентов до этого изменения (старый кэш
 * фронтенда без заголовка); человекочитаемый label всегда из UA независимо от источника key.
 */
export function resolveDeviceKey(req: Request): { label: string; key: string } {
  const userAgent = req.headers["user-agent"];
  const { label, key: uaKey } = parseDevice(userAgent);
  const header = req.headers["x-device-id"];
  const clientId = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  const trimmed = clientId?.trim();
  return { label, key: trimmed ? trimmed.slice(0, 100) : uaKey };
}
