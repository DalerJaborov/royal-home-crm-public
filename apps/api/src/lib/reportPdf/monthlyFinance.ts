import { findAutoPdfRecipients } from "../reportRecipients.js";
import { prisma } from "../../db.js";
import { logAgentAudit } from "../audit.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { currentDushanbeMonth } from "../financeForecast.js";
import { sendDocumentFile } from "../../telegram/api.js";
import { buildReportPdf } from "./build.js";

/**
 * ФИНАНСОВЫЙ PDF ЗА ПРОШЛЫЙ МЕСЯЦ — В TELEGRAM, 1-го ЧИСЛА (14.11.2026; круг расширен 27.11.2026:
 * директор, администратор и учредитель с правом на финансы, решение владельца).
 *
 * Выключено по умолчанию (Settings.financePdfMonthlyEnabled, тумблер в Настройках →
 * Система). Получатели — `findAutoPdfRecipients("finance.view")`: работающие директор,
 * администратор и учредитель со своим Telegram и правом на финансы; клиентам и
 * посторонним чатам файл не уходит по устройству.
 *
 * Повтор исключён: месяц сначала «захватывается» одной атомарной записью
 * (financePdfMonthlyLastSent), и только захвативший тик рассылает — второй процесс
 * или повторный запуск в тот же месяц ничего не пришлёт второй раз.
 */
export function previousMonthKey(now = new Date()): string {
  const [y, m] = currentDushanbeMonth(now).split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthlyFinancePdfResult {
  month: string;
  status: "disabled" | "already-sent" | "no-recipients" | "failed" | "sent";
  delivered: number;
  failed: number;
}

export async function sendMonthlyFinancePdf(now = new Date()): Promise<MonthlyFinancePdfResult> {
  const month = previousMonthKey(now);
  const claimed = await prisma.settings.updateMany({
    where: {
      id: "singleton",
      financePdfMonthlyEnabled: true,
      OR: [{ financePdfMonthlyLastSent: null }, { financePdfMonthlyLastSent: { not: month } }],
    },
    data: { financePdfMonthlyLastSent: month },
  });
  if (claimed.count === 0) {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { financePdfMonthlyEnabled: true } });
    return { month, status: settings?.financePdfMonthlyEnabled ? "already-sent" : "disabled", delivered: 0, failed: 0 };
  }

  // Отметка стоит до отправки (чтобы два процесса не разослали дважды), поэтому
  // любой исход «никому не дошло» её снимает: сбой Telegram, ни одного получателя,
  // ошибка базы, файл не собрался. Крон стучится 1–3 числа — следующий день повторит
  // (ревью 14.11: иначе месяц терялся молча). Дошло хоть одному — месяц закрыт.
  const release = () =>
    prisma.settings.updateMany({ where: { id: "singleton", financePdfMonthlyLastSent: month }, data: { financePdfMonthlyLastSent: null } });
  try {
    // Круг получателей — одна дверь автоматических PDF (lib/reportRecipients.ts, решение владельца
    // 27.11.2026): директор, администратор и учредитель, у кого есть право на финансы и свой Telegram.
    const recipients = await findAutoPdfRecipients("finance.view");
    if (recipients.length === 0) {
      await release();
      void logSystemError("telegram", `Финансовый PDF за ${month} не разослан: ни у директора, администратора или учредителя с правом на финансы не привязан Telegram`);
      return { month, status: "no-recipients", delivered: 0, failed: 0 };
    }

    // Один файл на всех: на обложке «CRM, по расписанию», а не имя получателя.
    const pdf = await buildReportPdf("finance", { month, months: 6 }, {
      agentId: "system",
      name: "CRM Royal Home, ежемесячная рассылка",
      role: null,
      can: (p) => p === "finance.view",
    }, now);

    let delivered = 0;
    let failed = 0;
    for (const r of recipients) {
      try {
        await sendDocumentFile(r.chatId, pdf.buffer, pdf.filename, `Финансовый отчёт · ${pdf.periodLabel}`);
        delivered += 1;
        logAgentAudit(r.id, "REPORT_PDF_EXPORT", "Report", "finance", { destination: "monthlyTelegram", period: pdf.periodKey, bytes: pdf.buffer.length, source: "cron" });
      } catch (err) {
        failed += 1;
        void logSystemError("telegram", `Финансовый PDF за ${month} не доставлен получателю ${r.id}: ${describeError(err)}`);
      }
    }
    if (delivered === 0) {
      await release();
      return { month, status: "failed", delivered, failed };
    }
    return { month, status: "sent", delivered, failed };
  } catch (err) {
    await release().catch(() => undefined);
    throw err;
  }
}
