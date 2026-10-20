import type { Prisma } from "../generated/prisma/client.js";
import { DEDUP_TEXT_LEN } from "./systemError.js";

/**
 * ДВЕ КАТЕГОРИИ ЖУРНАЛА ОШИБОК (аудит 03.09.2026 ночь, раздел 4-5:
 * docs/audit-02-09-2026/20-deep-audit-03-09-night.md).
 *
 * Живое доказательство усталости от алармов: утренний отчёт директору показал
 * «377 неразобранных ошибок, 17 разных типов за неделю». Разобрав типы, минимум
 * 6 из 17 оказались эксплуатационным шумом ИИ-конвейера («Gemini ответил на
 * резервной модели», «повтор не помог») — внутренней метрикой надёжности, а не
 * решением, которое ждёт от директора действия: бот и так ответил (просто не той
 * моделью) либо диалог уже подхватила фоновая очередь повторов (ai/aiRetryQueue.ts,
 * до ~13 часов) — тот же случай отдельно виден в «Диалогах без ответа сегодня»
 * (routes/errorLog.ts: /stuck-conversations), дублировать его здесь незачем.
 *
 * `operational` — CRM сама уже сделала всё, что могла (резерв ответил, повтор
 * встал в очередь): технический след для разработчика, НЕ для директора.
 * `actionable`  — либо человек ещё ничего не предпринял (новый вид поломки,
 * отказ без резерва/повтора), либо сигнал по своей природе требует человека
 * (например «номер в переписке есть — карточки нет», lib/phoneLeadWatchdog.ts).
 *
 * Разбирать по source бессмысленно: один и тот же source "ai" даёт и шум
 * (резерв справился), и настоящую тревогу (модель отказала HTTP 404 у Google
 * на каждый вызов) — поэтому классификация смотрит на ТЕКСТ сообщения, а не
 * на источник. Все паттерны ниже собраны по фразам, которые реально пишет код
 * (ai/client.ts, ai/geminiClient.ts) — при добавлении нового текста лога туда
 * стоит свериться и с этим списком.
 */
export type ErrorLogPriority = "operational" | "actionable";

/**
 * Сообщения об ЯВНОЙ тревоге (`ТРЕВОГА:` — geminiClient.ts: основная модель
 * отказывает часами, Google не знает имя модели) — ВСЕГДА actionable, даже если
 * по тексту ниже похожи на «резерв/повтор»: это ровно те случаи, для которых
 * порог тревоги и придуман, они не должны потеряться в операционной категории.
 */
const ALWAYS_ACTIONABLE = /^ТРЕВОГА/;

/**
 * Операционный шум ИИ-конвейера: резерв или повтор УЖЕ решили проблему снаружи
 * (клиент получил ответ, просто не основной моделью/не с первого раза), либо
 * отказ ушёл в фоновую очередь повторов, которая сама виднеется в
 * «Диалогах без ответа» — здесь дублировать нечего.
 */
const OPERATIONAL_PATTERNS: RegExp[] = [
  // ai/geminiClient.ts: `Gemini ответил на РЕЗЕРВНОЙ модели ...`,
  // `Ассистент ответил на РЕЗЕРВНОЙ модели ...` — бот ответил, просто не основной.
  /ответил на РЕЗЕРВНОЙ модели/i,
  // ai/client.ts: единая точка текстового вызова — повтор у того же поставщика.
  /Gemini не ответил с первого раза .* помог повтор/i,
  /Gemini не ответил .*, повтор тоже не помог/i,
  // lib/telephony/liveVoiceBridge.ts: расшифровка успешного звонка и приём
  // исходящего тестового звонка — обычные события живого голоса, не поломки
  // (15.09.2026: больше половины строк в «⚠️ поймано N ошибок» директору были
  // этими двумя сообщениями). Идут через logSystemError ради самой записи в
  // журнал (страница «Здоровье системы» и история звонков), но директору в
  // отчёте не нужны — готового отдельного info-уровня в ErrorLog нет (схема
  // без миграции), поэтому используем этот же, уже существующий фильтр.
  /^Живой голос: расшифровка звонка/,
  /^Живой голос: исходящий тестовый звонок принят/,
  // ai/geminiClient.ts: Google заблокировал промт по содержимому (blockReason,
  // например PROHIBITED_CONTENT) — решение по конкретному промту, повтор или
  // другая модель его не изменят. Вызывающий код (ai/scoring.ts и другие)
  // получает явный сигнал через onBlocked и деградирует мягко; директору
  // такая запись не даёт задачи — это не отказ поставщика.
  /Gemini заблокировал промт/,
];

/**
 * ТО ЖЕ ПРАВИЛО УСЛОВИЕМ ДЛЯ БАЗЫ (02.10.2026). Журнал ошибок листается
 * страницами, и отбор «только требующие внимания» обязан идти в самой выборке:
 * раньше роут брал 200 свежих строк и отсеивал шум в памяти — всплеск из двухсот
 * «ответил на резервной модели» прятал ВСЕ настоящие ошибки, список выглядел
 * чистым. Регулярок база через Prisma не понимает, поэтому каждый образец выше
 * переписан подстроками — ровно теми, что пишет код (ai/client.ts,
 * ai/geminiClient.ts, lib/telephony/liveVoiceBridge.ts). Меняешь список выше —
 * меняй и этот: тест error-log-priority-filter.test.ts сверяет оба на образцах.
 */
const OPERATIONAL_MATCH: Prisma.ErrorLogWhereInput[] = [
  { message: { contains: "ответил на РЕЗЕРВНОЙ модели" } },
  { AND: [{ message: { contains: "Gemini не ответил с первого раза" } }, { message: { contains: "помог повтор" } }] },
  { AND: [{ message: { contains: "Gemini не ответил" } }, { message: { contains: ", повтор тоже не помог" } }] },
  { message: { startsWith: "Живой голос: расшифровка звонка" } },
  { message: { startsWith: "Живой голос: исходящий тестовый звонок принят" } },
  { message: { contains: "Gemini заблокировал промт" } },
];
const ALWAYS_ACTIONABLE_WHERE: Prisma.ErrorLogWhereInput = { message: { startsWith: "ТРЕВОГА" } };

/** Условие выборки для `?priority=` — то же разделение, что classifyErrorLog. */
export function errorLogPriorityWhere(priority: ErrorLogPriority): Prisma.ErrorLogWhereInput {
  return priority === "operational"
    ? { AND: [{ NOT: ALWAYS_ACTIONABLE_WHERE }, { OR: OPERATIONAL_MATCH }] }
    : { OR: [ALWAYS_ACTIONABLE_WHERE, { NOT: { OR: OPERATIONAL_MATCH } }] };
}

/** Стабильный ключ группировки: source + начало сообщения без переменной части
 *  (id диалога, имя файла, HTTP-детали) — то же число символов, каким
 *  `logSystemError` уже дедуплицирует одинаковые поломки (systemError.ts). */
export function errorGroupKey(source: string, message: string): string {
  return `${source}|${String(message).slice(0, DEDUP_TEXT_LEN)}`;
}

export function classifyErrorLog(source: string, message: string): ErrorLogPriority {
  const text = String(message);
  if (ALWAYS_ACTIONABLE.test(text)) return "actionable";
  if (OPERATIONAL_PATTERNS.some((re) => re.test(text))) return "operational";
  return "actionable";
}

/**
 * «Номер в переписке есть — карточки нет» (lib/phoneLeadWatchdog.ts, ступень 3,
 * 03.09.2026) — настоящий actionable-сигнал, но частично дублирует то, что
 * решается отдельным детектором дублей (план владельца, пункт L). Не убираем
 * сигнал — только не даём ему всплывать первым в отчёте, пока дубли не сведены
 * в одно место: сортировка отчёта отправляет такие группы в конец actionable-списка.
 */
export function isDuplicateLeadSignal(message: string): boolean {
  return String(message).startsWith("[alarm]");
}

export interface GroupableErrorLog {
  source: string;
  message: string;
  url?: string | null;
  createdAt: Date;
}

export interface ErrorLogGroup {
  source: string;
  message: string;
  url: string | null;
  lastAt: Date;
  /** Сколько раз одна и та же поломка повторилась в исходном списке. */
  count: number;
  priority: ErrorLogPriority;
  /** «Номер без карточки» — не прячем, но отправляем в конец списка (см.
   *  isDuplicateLeadSignal). */
  lowPriority: boolean;
}

/**
 * Схлопывает пачку строк ErrorLog в уникальные ТИПЫ с count — ровно то, чего не
 * хватало утреннему отчёту: «377 неразобранных» была суммой повторов одной и той
 * же поломки, а не числом разных проблем. Сортировка: свежие сверху,
 * низкоприоритетные («номер без карточки», уже частично дублирует детектор
 * дублей) — в конце, чтобы не оттягивали внимание директора первыми.
 */
export function groupErrorLogEntries<T extends GroupableErrorLog>(rows: T[]): ErrorLogGroup[] {
  const groups = new Map<string, ErrorLogGroup>();
  for (const row of rows) {
    const key = errorGroupKey(row.source, row.message);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (row.createdAt > existing.lastAt) existing.lastAt = row.createdAt;
    } else {
      groups.set(key, {
        source: row.source,
        message: String(row.message).slice(0, 300),
        url: row.url ?? null,
        lastAt: row.createdAt,
        count: 1,
        priority: classifyErrorLog(row.source, row.message),
        lowPriority: isDuplicateLeadSignal(row.message),
      });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.lowPriority !== b.lowPriority) return a.lowPriority ? 1 : -1;
    return b.lastAt.getTime() - a.lastAt.getTime();
  });
}
