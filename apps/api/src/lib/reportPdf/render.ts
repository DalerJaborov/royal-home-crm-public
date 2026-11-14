import type { ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";

/**
 * ОДНА ДВЕРЬ ДЛЯ РЕНДЕРА PDF. Вёрстка PDF — работа процессора в том же процессе,
 * что отвечает на все запросы CRM. Поэтому:
 *   • одновременно собирается не больше MAX_PARALLEL файлов — остальным честный
 *     отказ «PDF уже готовится», а не общая подвисшая CRM;
 *   • на сборку есть потолок времени — дольше ждать человеку незачем.
 */
const MAX_PARALLEL = 2;
export const RENDER_TIMEOUT_MS = 30_000;
let running = 0;

export class ReportPdfBusyError extends Error {
  constructor() {
    super("Сейчас уже готовится другой PDF — повторите через минуту");
  }
}

export class ReportPdfTimeoutError extends Error {
  constructor() {
    super(`PDF не собрался за ${RENDER_TIMEOUT_MS / 1000} с`);
  }
}

export async function renderReportPdf(doc: ReactElement<DocumentProps>, timeoutMs = RENDER_TIMEOUT_MS): Promise<Buffer> {
  if (running >= MAX_PARALLEL) throw new ReportPdfBusyError();
  running += 1;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      renderToBuffer(doc),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReportPdfTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    running -= 1;
  }
}
