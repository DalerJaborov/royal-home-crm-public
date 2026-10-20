import jwt from "jsonwebtoken";

// Короткоживущий токен, доказывающий "этот запрос уже прошёл проверку пароля
// для этого агента" — выдаётся после шага 1 логина, если нужен второй шаг
// (код из приложения или код по СМС), и предъявляется на шаге 2
// (/auth/login/verify-totp или /auth/login/verify-sms). Специально
// отдельный секрет/формат от access/refresh токенов, чтобы его нельзя было
// перепутать с настоящей сессией и использовать для доступа к API.
//
// У каждого второго шага своё назначение (purpose): токен, выданный под код
// по СМС, не принимается проверкой кода из приложения и наоборот. Иначе
// сотрудник с включённым кодом из приложения мог бы пройти вход более слабым
// способом, подставив токен в чужой маршрут.
const SECRET = process.env.JWT_ACCESS_SECRET!;
const PURPOSES = { totp: "totp-pending", sms: "sms-pending" } as const;
export type Pending2faKind = keyof typeof PURPOSES;

export function signPending2faToken(agentId: string, kind: Pending2faKind = "totp"): string {
  return jwt.sign({ sub: agentId, purpose: PURPOSES[kind] }, SECRET, { expiresIn: "5m" });
}

/** kind "any" — только для ключа лимитера попыток (app.ts): там важно, чей
 *  это вход, а не каким способом он подтверждается. */
export function verifyPending2faToken(token: string, kind: Pending2faKind | "any" = "totp"): string | null {
  try {
    const payload = jwt.verify(token, SECRET) as { sub: string; purpose: string };
    const allowed: string[] = kind === "any" ? Object.values(PURPOSES) : [PURPOSES[kind]];
    if (!allowed.includes(payload.purpose)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
