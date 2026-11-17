import { addExpensesPlugin } from "./expenseBatchTool.js";
import { expenseReadTools } from "./expenseReadTools.js";
import { expenseWriteTools } from "./expenseWriteTools.js";
import type { AssistantToolPlugin } from "./types.js";

/**
 * Группа «расходы» (10.11.2026): всё, что умеет экран «Расходы», — чтение (A) и
 * изменения карточкой подтверждения (C). Права — finance.view / finance.manage.
 */
export const expenseTools: readonly AssistantToolPlugin[] = [...expenseReadTools, addExpensesPlugin, ...expenseWriteTools];

/** Имена инструментов про деньги — закрыты в общей группе Telegram (assistantBot.ts). */
export const EXPENSE_TOOL_NAMES: readonly string[] = expenseTools.map((tool) => tool.name);
