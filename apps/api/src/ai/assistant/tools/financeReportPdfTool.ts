import { z } from "zod";
import { prisma } from "../../../db.js";
import { sendReportPdfToOwnTelegram } from "../../../lib/reportPdf/ownTelegram.js";
import { financeReadAllowed } from "./expenseToolSupport.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * «ПРИШЛИ ФИНАНСОВЫЙ ОТЧЁТ PDF» — ШАБНАМ ШЛЁТ ФАЙЛ СРАЗУ (27.11.2026).
 *
 * Скриншот владельца 27.11: попросил финансовый отчёт, получил текст, а на «почему не в
 * PDF» Шабнам ответила «я не могу сама формировать PDF, он приходит в конце месяца».
 * Файл собирать умела CRM (кнопка «В Telegram» на экране отчётов и рассылка 1-го числа),
 * не умела только Шабнам. Теперь — тот же файл той же дверью
 * (lib/reportPdf/ownTelegram.ts): за текущий или названный месяц, в СВОЙ привязанный чат.
 *
 * Уровень A (чтение): данные не меняются, файл уходит только самому человеку. Поэтому
 * открыт и акционеру (режим просмотра). Доступ — право «Финансы» (finance.view): директор,
 * администратор с этим правом, акционер; РОПу и агентам по умолчанию нет. В общей группе
 * Telegram деньги скрыты (financeReadAllowed).
 */
const argsSchema = z.object({
  month: z
    .string()
    .regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/)
    .nullish()
    .transform((v) => v ?? undefined),
});

export const sendFinanceReportPdfTool: AssistantReadToolPlugin = {
  name: "send_finance_report_pdf",
  level: "A",
  description:
    "Собрать финансовый отчёт PDF (доходы, расходы, прибыль за месяц и полгода до него, прогноз, взносы учредителей) и " +
    "сразу прислать файлом в личный Telegram человека. Звать, когда просят отчёт ФАЙЛОМ / PDF / «пришли отчёт», в том " +
    "числе после текстового ответа («а почему не в PDF?»). Месяц — ГГГГ-ММ; не назван — текущий. Будущий месяц нельзя. " +
    "Файл уходит только самому человеку. Получил ok — скажи коротко, что файл отправлен. Получил error — перескажи его " +
    "честно; не говори «не могу формировать PDF» и не обещай файл без вызова.",
  parameters: {
    type: "object",
    properties: {
      month: { type: "string", description: "Месяц ГГГГ-ММ, например 2026-11. Не указан — текущий." },
    },
  },
  statusPhrase: "Собираю PDF-отчёт…",
  allowed: (actor) => financeReadAllowed(actor),
  async run(raw, ctx) {
    const actor = ctx.actor;
    if (!financeReadAllowed(actor)) return { error: "Финансовый отчёт вам не открыт — спросите руководителя" };
    const parsed = argsSchema.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Месяц нужен в виде ГГГГ-ММ, например 2026-11" };
    const me = await prisma.agent.findUnique({ where: { id: actor.id }, select: { fullName: true } });
    const outcome = await sendReportPdfToOwnTelegram(
      {
        agentId: actor.id,
        name: me?.fullName ?? "Сотрудник Royal Home",
        role: actor.role,
        can: (p) => actor.permissions?.has(p) ?? false,
      },
      "finance",
      parsed.data.month ? { month: parsed.data.month } : {},
      { source: "assistant" },
    );
    if (outcome.ok) return { ok: true, sent: "Файл отправлен в личный Telegram", period: outcome.periodLabel };
    if (outcome.code === "NO_TELEGRAM") {
      return { error: "Telegram не привязан: CRM → Профиль → «Личный чат с ботом CRM в Telegram» → «Привязать»" };
    }
    if (outcome.code === "INPUT") return { error: outcome.error };
    if (outcome.code === "TOO_OFTEN") return { error: outcome.error };
    return { error: "Не получилось собрать или отправить отчёт. Попробуйте позже" };
  },
};
