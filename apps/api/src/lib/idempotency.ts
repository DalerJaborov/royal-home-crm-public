import type { NextFunction, Request, Response } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { logSystemError } from "./systemError.js";

/**
 * ПОВТОР ЗАПИСИ НЕ СОЗДАЁТ ВТОРУЮ СТРОКУ (23.09.2026, аудит к стабильной версии).
 *
 * Как рождались дубли. Сайт ждёт ответа 30 секунд (web/lib/api.ts), а создание
 * объекта перед записью дважды ходит к модели (SEO и подпись ролика, до 75 с
 * каждая). Сайт обрывал запрос, клал его в офлайн-очередь и показывал «не
 * удалось сохранить» — а сервер тем временем честно досчитывал и создавал
 * объект. Потом срабатывала очередь, или агент жал «Сохранить» ещё раз, и
 * получались два-три одинаковых объекта с двойными баллами. Тот же механизм у
 * всех записей с офлайн-очередью: клиент, сделка, запись в хронологию.
 *
 * Лечение одно на все: сайт шлёт заголовок `Idempotency-Key` (один ключ на одно
 * намерение: на одно открытие мастера, на одну запись в очереди), а сервер
 * помнит, что по этому ключу уже ответил.
 *  - первый запрос: строка без статуса («выполняется»), дальше обычный роут;
 *  - ответ 2xx: статус и тело запоминаются, повтор получает ИХ ЖЕ;
 *  - ответ не 2xx: строка удаляется — ошибку можно исправить и повторить;
 *  - повтор, пока первый ещё идёт: 409 с понятным текстом (офлайн-очередь
 *    выбрасывает 4xx, и это правильно: первый запрос сам доведёт дело).
 *
 * Ключ принадлежит сотруднику (по токену): чужой ключ не отдаёт чужой ответ.
 * Невалидный токен — просто пропускаем, 401 скажет requireAuth.
 *
 * Щиток стоит ДО requireAuth и знает про токен только подпись, поэтому ОТДАЧА
 * СОХРАНЁННОГО ОТВЕТА сверяет доступ тем же способом, что requireAuth
 * (loadAgentAccess, тот же короткий кэш): отключённый сотрудник и сотрудник с
 * временным паролем повтор не получают (находка Codex №4, 04.10.2026). Иначе
 * ответ, пройдя signMediaUrlsInResponses, отдавал бы им заново подписанные
 * ссылки на медиа. Новую запись повтор не запускает и раньше, правка — про
 * доступ к уже полученному телу.
 */

export const IDEMPOTENCY_HEADER = "idempotency-key";
/** Сколько помним ответ. Офлайн-очередь на телефоне может ждать сети и сутки. */
const KEEP_MS = 3 * 24 * 60 * 60_000;
/** Дольше этого «выполняется» — первый запрос умер вместе с процессом; ключ
 *  можно занять заново. Потолок самого долгого роута сайта — 15 минут. */
const STALE_PENDING_MS = 16 * 60_000;
const KEY_RE = /^[A-Za-z0-9:_-]{8,120}$/;

export const IN_PROGRESS_MESSAGE = "Этот запрос уже выполняется — дождитесь результата, повторять не нужно";

let lastSweep = 0;
function sweepOld(now: number) {
  if (now - lastSweep < 60 * 60_000) return;
  lastSweep = now;
  void prisma.idempotencyKey
    .deleteMany({ where: { createdAt: { lt: new Date(now - KEEP_MS) } } })
    .catch((err) => void logSystemError("api", `Не удалось убрать старые ключи повтора: ${String(err)}`));
}

function agentFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    return verifyAccessToken(header.slice("Bearer ".length)).sub;
  } catch {
    return null;
  }
}

export async function idempotencyGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  const key = req.get(IDEMPOTENCY_HEADER);
  if (!key) return next();
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "Неверный Idempotency-Key" });
  const agentId = agentFromRequest(req);
  if (!agentId) return next();

  const path = req.originalUrl.split("?")[0];
  const now = Date.now();
  sweepOld(now);

  let rowId: string;
  try {
    rowId = (
      await prisma.idempotencyKey.create({
        data: { agentId, key, method: req.method, path },
        select: { id: true },
      })
    ).id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      // База не ответила — не мешаем записи: без щитка лучше, чем без записи.
      void logSystemError("api", `Ключ повтора не записан: ${String(err)}`);
      return next();
    }
    const existing = await prisma.idempotencyKey.findUnique({ where: { agentId_key: { agentId, key } } });
    if (!existing) return next();
    if (existing.path !== path) {
      return res.status(422).json({ error: "Этот ключ уже использован для другого запроса" });
    }
    if (existing.status !== null) {
      let access;
      try {
        access = await loadAgentAccess(agentId);
      } catch (err) {
        // Как в requireAuth: сбой проверки доступа — временный отказ, а не повод
        // отдать тело без проверки.
        void logSystemError("api", `Не удалось проверить доступ при повторе по ключу: ${String(err)}`);
        res.set("Retry-After", "2");
        return res.status(503).json({ error: "Сервис временно недоступен, повторите запрос" });
      }
      if (!access) return res.status(401).json({ error: "Учётная запись не найдена" });
      if (!access.isActive) return res.status(403).json({ error: "Учётная запись отключена", accountDisabled: true });
      res.set("Idempotent-Replayed", "true");
      return res.status(existing.status).json(existing.body);
    }
    if (now - existing.createdAt.getTime() < STALE_PENDING_MS) {
      return res.status(409).json({ error: IN_PROGRESS_MESSAGE, inProgress: true });
    }
    // Первый запрос умер, не ответив. Занимаем ключ заново — атомарно, чтобы два
    // одновременных повтора не прошли оба.
    const taken = await prisma.idempotencyKey.updateMany({
      where: { id: existing.id, status: null, createdAt: existing.createdAt },
      data: { createdAt: new Date(now) },
    });
    if (taken.count === 0) return res.status(409).json({ error: IN_PROGRESS_MESSAGE, inProgress: true });
    rowId = existing.id;
  }

  let settled = false;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!settled) {
      settled = true;
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        void prisma.idempotencyKey
          .update({
            where: { id: rowId },
            data: { status, body: (body ?? null) as Prisma.InputJsonValue, completedAt: new Date() },
          })
          .catch((err) => void logSystemError("api", `Ответ для ключа повтора не сохранён: ${String(err)}`));
      } else {
        void prisma.idempotencyKey.delete({ where: { id: rowId } }).catch(() => {});
      }
    }
    return originalJson(body);
  };
  // Ответ ушёл не через json (send/end) — ключ освобождаем. Именно "finish", а
  // не "close": "close" приходит и тогда, когда САЙТ оборвал ожидание, а роут ещё
  // работает, — ровно случай дубля. Такой роут потом всё равно зовёт res.json,
  // и ответ запоминается для повтора.
  res.on("finish", () => {
    if (settled) return;
    settled = true;
    void prisma.idempotencyKey.delete({ where: { id: rowId } }).catch(() => {});
  });
  next();
}
