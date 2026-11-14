import type { ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";

/**
 * ОДНА ДВЕРЬ ДЛЯ СБОРКИ PDF. Выборка данных и вёрстка — работа в том же
 * процессе, что отвечает на все запросы CRM. Поэтому:
 *   • одновременно собирается не больше MAX_PARALLEL файлов — остальным честный
 *     отказ «PDF уже готовится», а не общая подвисшая CRM;
 *   • место занимается ДО запроса к базе и освобождается, только когда сборка
 *     действительно закончилась (ревью 14.11): вёрстку react-pdf таймер прервать
 *     не может, и если освобождать место по тайм-ауту, реальных сборок
 *     одновременно становится больше двух;
 *   • на ответ человеку есть потолок времени — дольше ждать незачем.
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

export async function withReportPdfSlot<T>(work: () => Promise<T>, timeoutMs = RENDER_TIMEOUT_MS): Promise<T> {
  if (running >= MAX_PARALLEL) throw new ReportPdfBusyError();
  running += 1;
  let job: Promise<T>;
  try {
    job = work();
  } catch (err) {
    running -= 1;
    throw err;
  }
  // Место освобождает конец работы, а не тайм-аут ответа.
  job.then(
    () => { running -= 1; },
    () => { running -= 1; },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      job,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReportPdfTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function renderReportPdf(doc: ReactElement<DocumentProps>): Promise<Buffer> {
  return renderToBuffer(doc);
}

/** Для тестов: сколько сборок идёт сейчас. */
export function runningReportPdfs(): number {
  return running;
}
