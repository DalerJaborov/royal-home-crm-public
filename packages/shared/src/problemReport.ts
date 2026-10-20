import { z } from "zod";

/**
 * РАЗБОР ПРОБЛЕМНЫХ МЕСТ — форма еженедельного и ежемесячного отчёта.
 *
 * Решение владельца 11.08.2026, дословно: «надо добавить, чтобы был еженедельный
 * крупный отчёт и ежемесячный отчёт по всем проблемным местам агентов и клиентов,
 * чтобы понять, где происходит потеря контакта клиента, агента и так далее».
 *
 * Тип живёт в @royal-home/shared, а не в двух копиях: сервер кладёт эту структуру в
 * `ProblemReport.metrics` (Json), интерфейс читает её оттуда же. Ровно на такой
 * копии уже разъезжался месячный отчёт — там форма описана и в lib/monthlyReport.ts,
 * и в components/MonthlyReports.tsx.
 *
 * ГЛАВНОЕ В ЭТОЙ ФОРМЕ — НЕ ЦИФРЫ. Владелец просил не таблицу чисел, а разбор:
 * поэтому у каждого раздела есть вывод одной фразой (`headline`), направление
 * против прошлого периода (`direction`) и ссылки прямо на проблемные карточки
 * (`links`) — чтобы из отчёта можно было сразу пойти чинить, а не искать руками.
 */

export const PROBLEM_REPORT_PERIODS = ["week", "month"] as const;
export type ProblemPeriod = (typeof PROBLEM_REPORT_PERIODS)[number];

export const PROBLEM_PERIOD_LABELS: Record<ProblemPeriod, string> = {
  week: "Неделя",
  month: "Месяц",
};

export const PROBLEM_SECTION_KEYS = ["clients", "agents", "calls", "properties"] as const;
export type ProblemSectionKey = (typeof PROBLEM_SECTION_KEYS)[number];

/** Одно число раздела: сколько потеряли и куда идти смотреть. */
export interface ProblemMetric {
  key: string;
  label: string;
  value: number;
  /**
   * Столько же было в прошлом периоде такой же длины.
   *
   * null — показатель «НА СЕЙЧАС» (объекты, застрявшие в подготовке; объекты без
   * спроса). Восстановить его на прошлую неделю нельзя: в базе лежит текущее
   * состояние объекта, а не история его состояний, и «сравнение» получилось бы
   * выдуманным. Такие показатели в динамику раздела не входят вовсе.
   */
  previous: number | null;
  /** Куда ведёт цифра в CRM. null — общего экрана для неё нет. */
  href: string | null;
  /** Почему это проблема — одной строкой, если из названия не очевидно. */
  hint?: string;
}

/** Конкретная карточка, которую можно пойти и починить прямо сейчас. */
export interface ProblemLink {
  label: string;
  hint: string;
  href: string;
}

/** Разбивка внутри раздела: топ причин отказов, шаги разговора и т.п. */
export interface ProblemBreakdown {
  title: string;
  rows: { label: string; count: number }[];
}

export interface ProblemSection {
  key: ProblemSectionKey;
  title: string;
  /** Главный вывод раздела одной фразой — то, ради чего отчёт и открывают. */
  headline: string;
  /** Сумма СРАВНИМЫХ показателей раздела (те, у которых previous не null). */
  total: number;
  previousTotal: number;
  /** Стало лучше, хуже или так же — по сравнимой части раздела. */
  direction: "better" | "worse" | "same";
  metrics: ProblemMetric[];
  links: ProblemLink[];
  breakdown: ProblemBreakdown | null;
}

export interface ProblemReportMetrics {
  period: ProblemPeriod;
  /** ISO границ периода — подпись отчёта не должна зависеть от того, что фронт
   *  сам вычислит из periodStart записи. */
  periodStart: string;
  periodEnd: string;
  /** Одна фраза про весь отчёт: где сейчас теряем больше всего. */
  headline: string;
  sections: ProblemSection[];
}

/** GET /reports/problems?period=week|month — история отчётов одного вида. */
export const problemReportQuerySchema = z.object({
  period: z.enum(PROBLEM_REPORT_PERIODS).default("week"),
});

/** POST /reports/problems/generate — собрать отчёт немедленно, не дожидаясь крона. */
export const problemReportGenerateSchema = z.object({
  period: z.enum(PROBLEM_REPORT_PERIODS),
});

/** PATCH /reports/problems/:id — заметки владельца поверх цифр. Пустая строка
 *  допустима: это способ их очистить (как у месячного отчёта). */
export const problemReportNotesSchema = z.object({
  notes: z.string().max(10000),
  /** Голосовая заметка к notes (кнопка микрофона) — необязательна. */
  notesVoiceUrl: z.string().max(500).nullable().optional(),
  notesVoiceTranscript: z.string().max(4000).nullable().optional(),
});
