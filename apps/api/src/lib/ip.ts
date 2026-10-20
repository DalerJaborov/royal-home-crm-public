import type { Request } from "express";

/** Реальный IP клиента — корректен, только если Express настроен доверять реверс-прокси
 * (app.set("trust proxy", ...) в app.ts, включается TRUST_PROXY=1 в .env). Без этого за
 * nginx/докер-сетью req.ip — адрес прокси/шлюза docker-сети, а не клиента: так все входы
 * в журнале выглядели одинаковыми (см. LoginLog/Session). */
export function clientIp(req: Request): string | null {
  return req.ip ? req.ip.replace(/^::ffff:/, "") : null;
}
