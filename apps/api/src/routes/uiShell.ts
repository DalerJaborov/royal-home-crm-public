import { Router } from "express";
import { UI_SHELL_FOR_EVERYONE, type UiShellEffective } from "@royal-home/shared";
import { requireAuth } from "../auth/middleware.js";

/**
 * НОВЫЙ ИНТЕРФЕЙС ДЛЯ ВСЕХ (владелец 21.11.2026).
 *
 * Раньше здесь жил рубильник по сотрудникам и ролям (`/ui-shell/config`, блок
 * «Новый интерфейс CRM» в Настройках). Владелец его убрал: новый интерфейс и
 * «Новый вид» включены всем. Решение — одна константа в packages/shared
 * (`UI_SHELL_FOR_EVERYONE`); новый клиент её берёт сам и сюда не ходит.
 * GET остаётся для вкладок, открытых до выката: прежний клиент спрашивает его
 * при старте и раз в 30 секунд и по ответу переходит в новый интерфейс.
 * Поле `Settings.uiShellRollout` в базе не читается и не пишется (миграции нет).
 */
export const uiShellRouter = Router();
uiShellRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
uiShellRouter.use(requireAuth);

uiShellRouter.get("/", (_req, res) => {
  const body: UiShellEffective = { ...UI_SHELL_FOR_EVERYONE };
  res.json(body);
});
