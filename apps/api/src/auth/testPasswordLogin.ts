/**
 * ВХОД ПАРОЛЕМ — ТОЛЬКО ДЛЯ ПРОГОНА ТЕСТОВ (19.10.2026).
 *
 * На сайте пароля больше нет: вход по коду СМС/Telegram (routes/auth.ts). Но
 * больше трёхсот тестов сервера заводят сотрудника с `passwordHash` и входят
 * старым `POST /auth/login`, а права проверяют через `/step-up` паролем. Этот
 * маршрут держит их на ходу, проверяя ровно то же, что раньше, — и подключается
 * в app.ts ТОЛЬКО под vitest и не в production. На проде его нет вовсе:
 * старый `/auth/login` там отвечает 410.
 *
 * Запрос без пароля в теле (новые тесты кода) уходит дальше, в настоящий authRouter.
 */
import { Router } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../db.js";
import { issueSession } from "../routes/auth.js";
import { signPending2faToken } from "../lib/pending-2fa.js";
import { grantElevation } from "../lib/stepUp.js";
import { requireAuth } from "./middleware.js";

export const testPasswordLoginRouter = Router();

testPasswordLoginRouter.post("/login", async (req, res) => {
  const { phone, password } = (req.body ?? {}) as { phone?: unknown; password?: unknown };
  if (typeof phone !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Неверные данные" });
  }
  const agent = await prisma.agent.findUnique({ where: { phone } });
  if (!agent || !agent.isActive || !agent.passwordHash || !(await bcrypt.compare(password, agent.passwordHash))) {
    return res.status(401).json({ error: "Неверный телефон или пароль" });
  }
  if (agent.totpEnabled) return res.json({ requiresTotp: true, pendingToken: signPending2faToken(agent.id) });
  await issueSession(req, res, agent);
});

testPasswordLoginRouter.post("/step-up", requireAuth, async (req, res, next) => {
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (typeof password !== "string") return next();
  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } });
  if (!agent || agent.totpEnabled || !agent.passwordHash || !(await bcrypt.compare(password, agent.passwordHash))) {
    return res.status(401).json({ error: "Неверный пароль" });
  }
  const settings = await prisma.settings
    .findUnique({ where: { id: "singleton" }, select: { stepUpMinutes: true } })
    .catch(() => null);
  grantElevation(agent.id, settings?.stepUpMinutes);
  res.json({ elevated: true });
});
