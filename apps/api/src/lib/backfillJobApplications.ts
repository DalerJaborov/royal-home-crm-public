/**
 * ДОБОР ПРОПУЩЕННЫХ АНКЕТ КАНДИДАТОВ ИЗ УЖЕ СОСТОЯВШИХСЯ ПЕРЕПИСОК
 * (разовый, 03.09.2026; владелец: «все, кто отправили данные, но не попали в
 * CRM, — добавь их сам»).
 *
 * Предыстория. Анкету заполняет бот по ходу разговора (ai/jobApplication.ts →
 * lib/jobApplications.ts), и записать её он мог только в тот момент, когда
 * человек писал. Всё, что прошло мимо — разговоры до включения рубильника
 * «Вакансии», ходы, где модель не вернула поле, ходы, потерянные сбоем ИИ, и
 * запись, упавшая в проглоченном catch, — в разделе не появится уже никогда:
 * переписка осталась, а анкеты нет.
 *
 * Скрипт проходит по перепискам ЗАНОВО и достаёт анкету из всей истории сразу,
 * а не по одному ходу. Дальше — та же самая `recordJobApplication`, что и у
 * бота: одна запись на диалог, поля накапливаются, допуск (моложе 24 / учится /
 * работает) считает тот же код. Значит, добранная анкета ничем не отличается от
 * собранной вживую, и второй прогон её не испортит — upsert по conversationId.
 *
 * ЧЕГО СКРИПТ НЕ ДЕЛАЕТ: не пишет людям, не меняет статусы уже разобранных
 * анкет (существующие диалоги с записью пропускаются целиком) и без `--apply`
 * не трогает базу вовсе.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL и ключом Gemini):
 *     npm run backfill:job-applications                           — показать, кого нашли
 *     npm run backfill:job-applications -- --apply               — записать анкеты
 *     npm run backfill:job-applications -- --apply --limit=50
 * (то же самое, что `npx tsx src/lib/backfillJobApplications.ts …`; файла
 * scripts/backfill-job-applications.ts, на который ссылалась прежняя шапка, нет.)
 *
 * На проде — внутри контейнера api, собранным файлом (из каталога репозитория
 * на сервере, после выката; tsx и каталог scripts/ в прод-образ не входят —
 * поэтому скрипт и лежит в src/lib):
 *     docker compose -f docker-compose.prod.yml --env-file .env.production exec api \
 *       node dist/lib/backfillJobApplications.js --apply
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../db.js";
import { callAiText } from "../ai/client.js";
import { JOB_APPLICATION_SCHEMA_FIELD, parseJobApplication } from "../ai/jobApplication.js";
import { recordJobApplication } from "./jobApplications.js";

const APPLY = process.argv.includes("--apply");
const LIMIT = (() => {
  const raw = process.argv.find((a) => a.startsWith("--limit="));
  const n = raw ? Number.parseInt(raw.slice("--limit=".length), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 300;
})();

/** Потолок реплик и длины одной — те же соображения, что в ai/cardFill.ts:
 *  пересланное резюме на три страницы не должно раздувать запрос. */
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 700;

/**
 * ПРЕДФИЛЬТР ПО СЛОВАМ — ЧТОБЫ НЕ ПЛАТИТЬ ЗА РАЗБОР ВСЕХ ДИАЛОГОВ ПОДРЯД.
 *
 * Ловим не «правильные» формулировки, а то, как о работе пишут вживую: русский,
 * таджикский (кириллицей и латиницей), узбекский — так, как это приходит в
 * Instagram и WhatsApp. Предфильтр намеренно широкий: лишний диалог стоит одного
 * дешёвого разбора, пропущенный — потерянного кандидата. Окончательное решение,
 * разговор ли это о работе, принимает модель ниже, а не эта регулярка.
 */
const JOB_HINT =
  /(вакан|ваканс|работ|роботу|подработ|устро\p{L}*\s*на\s*работ|резюме|анкет|riel|риелт|риэлт|агент\p{L}*\s*по\s*недвиж|стажир|обучен\p{L}*\s*риелт|ищу\s*работ|нужна\s*работ|кор\s|кори\s|ҷои\s*кор|чои\s*кор|кор\s*ҳаст|кор\s*хаст|кор\s*мекунам|кор\s*кардан|ish\s|ishga|vakansiya|kor\s*hast|joi\s*kor)/iu;

interface Row {
  id: string;
  channel: string;
  contactName: string | null;
  messages: unknown;
  lastMessageAt: Date | null;
}

/** Реплики лежат в Json-колонке — приводим к списку, не доверяя форме. */
export function readMessages(raw: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (typeof content !== "string" || content.trim().length === 0) continue;
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return out.slice(-MAX_MESSAGES);
}

/**
 * Разбор одной переписки. Модель отвечает двумя полями: был ли это вообще
 * разговор о работе — и анкета. Вопрос «был ли» задаётся ОТДЕЛЬНО и первым:
 * без него модель, увидев схему анкеты, охотно заполняет её для клиента,
 * который спрашивал про квартиру, и раздел найма засоряется покупателями.
 */
export type Extracted =
  /** Разговор о работе, и в нём есть что записать. */
  | { kind: "draft"; draft: NonNullable<ReturnType<typeof parseJobApplication>> }
  /** Модель прочитала переписку и говорит: это не про работу (или сказать нечего). */
  | { kind: "not-job" }
  /**
   * ИИ НЕ ОТВЕТИЛ — И ЭТО НЕ «НЕ ПРО РАБОТУ» (поймано пробным прогоном 03.09.2026:
   * ключ Gemini отвечал 401, а скрипт бодро отчитался «не про работу — 1»). Такой
   * отчёт хуже ошибки: человек читает «кандидатов нет» там, где на самом деле не
   * работал разбор, и больше к этим перепискам не возвращается.
   */
  | { kind: "ai-unavailable" };

export async function extractFromHistory(
  messages: { role: "user" | "assistant"; content: string }[]
): Promise<Extracted> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "КАНДИДАТ" : "БОТ"}: ${m.content}`)
    .join("\n");

  const result = await callAiText<{ isJobConversation?: unknown; jobApplication?: unknown }>({
    endpoint: "backfill-job-application",
    simple: true,
    system:
      "Ты разбираешь архив переписки агентства недвижимости Royal Home и достаёшь анкеты тех, кто " +
      "писал НАСЧЁТ РАБОТЫ (устроиться риелтором/агентом, спросить про вакансию, прислать резюме).\n" +
      "Сначала честно ответь isJobConversation: true только если человек говорил о работе ДЛЯ СЕБЯ. " +
      "Клиент, который покупает, продаёт или снимает жильё, — false, даже если слово «работа» в " +
      "переписке встречается. Сомневаешься — false.\n" +
      "Затем заполни jobApplication по ВСЕЙ переписке сразу: только то, что человек сказал сам. " +
      "Ничего не выдумывай и не выводи по догадке: не спросили про возраст — поле не заполняй вовсе. " +
      "Поля про учёбу и текущую работу заполняй, только если об этом прямо говорили: пустое поле " +
      "лучше выдуманного «нет», по нему потом отсеют живого человека.",
    user: transcript,
    schema: {
      type: "object",
      properties: {
        isJobConversation: { type: "boolean", description: "Человек писал насчёт работы для себя" },
        ...JOB_APPLICATION_SCHEMA_FIELD,
      },
      required: ["isJobConversation"],
    },
    maxTokens: 900,
  });

  // null здесь означает ровно одно: модель не ответила (см. callAiText — отказ
  // поставщика возвращается тем же null). Мнение «не про работу» приходит
  // заполненным полем, а не пустотой.
  if (result === null) return { kind: "ai-unavailable" };
  if (result.isJobConversation !== true) return { kind: "not-job" };
  const draft = parseJobApplication(result.jobApplication);
  return draft ? { kind: "draft", draft } : { kind: "not-job" };
}

/**
 * СЧЁТ ПРОГОНА — ЧТОБЫ РАЗБОР МОЖНО БЫЛО НЕ ТОЛЬКО ПРОЧИТАТЬ ГЛАЗАМИ
 * (25.09.2026). Раньше итог жил только в `console.log`, а сам проход — в
 * приватной `main()`, завязанной на `process.argv`: позвать его из теста было
 * нечем, и файл попал в список тех, до которых не дотягивается ни одна
 * проверка. Теперь проход — обычная функция с параметрами, как у соседей по
 * жанру (`backfillContactProfiles`, `backfillInstagramUrls`), а `main()`
 * осталась тонкой обёрткой над ней: читает argv, печатает и выставляет код
 * возврата. Поведение и весь вывод прежние.
 */
export interface BackfillJobApplicationsStats {
  /** Сколько переписок вообще просмотрено. */
  scanned: number;
  /** Из них уже с анкетой — такие не трогаем вовсе. */
  alreadyRecorded: number;
  /** Прошли предфильтр по словам и ушли в разбор. */
  candidates: number;
  /** Записано анкет (в режиме просмотра всегда 0). */
  written: number;
  /** Анкеты, которые модель разобрала, но записать не удалось (сбой уже в журнале). */
  writeFailed: number;
  /** Модель сказала «не про работу». */
  notJob: number;
  /** Анкета вышла пустой — в очередь найма такую не кладём. */
  empty: number;
  /** Переписки, по которым ИИ не ответил: это НЕ «не про работу». */
  aiFailed: number;
  /** Разбор остановлен тремя отказами ИИ подряд. */
  stoppedOnAiFailures: boolean;
}

export async function backfillJobApplications({
  apply = false,
  limit = 300,
}: { apply?: boolean; limit?: number } = {}): Promise<BackfillJobApplicationsStats> {
  // Диалоги, у которых анкеты ещё нет. Записанные не трогаем вовсе: их уже
  // разбирает руководство, и переписывать чужие статусы скрипт не должен.
  const recorded = new Set(
    (
      await prisma.jobApplication.findMany({
        where: { conversationId: { not: null } },
        select: { conversationId: true },
      })
    ).map((r) => r.conversationId as string)
  );

  // `nulls: "last"` — НЕ украшение (найдено 29.09.2026 тестом этого файла).
  // В Postgres `ORDER BY ... DESC` ставит NULL ПЕРВЫМИ, а `lastMessageAt`
  // необязательное: оба боевых пути заводят диалог без него
  // (`messengers/conversation.ts`, `lib/whatsappFirstContact.ts` — дата
  // появляется только когда в диалог лягут сообщения). Диалоги, где ответа так
  // и не было, считались бы САМЫМИ свежими и съедали всё окно `take: limit` —
  // проход смотрел бы пустые переписки вместо настоящих и выдавал «кандидатов
  // нет». Ошибка тихая: это читается как хорошая новость.
  const freshestFirst = { sort: "desc", nulls: "last" } as const;
  const [bot, telegram] = await Promise.all([
    prisma.botConversation.findMany({
      orderBy: { lastMessageAt: freshestFirst },
      take: limit,
      select: { id: true, channel: true, name: true, messages: true, lastMessageAt: true },
    }),
    prisma.telegramConversation.findMany({
      orderBy: { lastMessageAt: freshestFirst },
      take: limit,
      select: { id: true, username: true, messages: true, lastMessageAt: true },
    }),
  ]);

  const rows: Row[] = [
    ...bot.map((c) => ({
      id: c.id,
      channel: c.channel,
      contactName: c.name,
      messages: c.messages,
      lastMessageAt: c.lastMessageAt,
    })),
    ...telegram.map((c) => ({
      id: c.id,
      channel: "TELEGRAM",
      contactName: c.username,
      messages: c.messages,
      lastMessageAt: c.lastMessageAt,
    })),
  ];

  const candidates = rows.filter((r) => {
    if (recorded.has(r.id)) return false;
    const messages = readMessages(r.messages);
    // Слова ищем ТОЛЬКО в репликах человека: бот сам произносит «вакансия» в
    // ответе-отказе, и по его словам в разбор попал бы каждый второй диалог.
    return messages.some((m) => m.role === "user" && JOB_HINT.test(m.content));
  });

  console.log(
    `Диалогов просмотрено: ${rows.length} (уже с анкетой: ${rows.filter((r) => recorded.has(r.id)).length}). ` +
      `Похожи на разговор о работе: ${candidates.length}.`
  );
  if (!apply) console.log("РЕЖИМ ПРОСМОТРА: база не изменится. Записать — тот же запуск с --apply.\n");

  let written = 0;
  let writeFailed = 0;
  let notJob = 0;
  let empty = 0;
  let aiFailed = 0;
  /** Отказы ИИ подряд — это сломанный ключ или упавший поставщик, а не свойство
   *  переписок. Дальше идти незачем: прогон только потратит время и оставит
   *  ложный отчёт «кандидатов нет». Останавливаемся и говорим прямо. */
  let aiFailedInARow = 0;
  let stopped = false;
  for (const row of candidates) {
    const messages = readMessages(row.messages);
    const extracted = await extractFromHistory(messages);
    if (extracted.kind === "ai-unavailable") {
      aiFailed++;
      if (++aiFailedInARow >= 3) {
        console.error(
          `ИИ не отвечает (${aiFailedInARow} отказа подряд) — разбор остановлен, чтобы не выдать ` +
            "ложное «кандидатов нет». Проверьте ключ Gemini и запустите скрипт заново: уже записанные " +
            "анкеты повторный прогон не тронет."
        );
        stopped = true;
        break;
      }
      continue;
    }
    aiFailedInARow = 0;
    if (extracted.kind === "not-job") {
      notJob++;
      continue;
    }
    const draft = extracted.draft;
    const filled = Object.entries(draft).filter(([, v]) => v !== undefined && v !== null).length;
    if (filled === 0) {
      // Пустая карточка в очереди найма хуже её отсутствия.
      empty++;
      continue;
    }

    const who = draft.name ?? row.contactName ?? "без имени";
    const when = row.lastMessageAt ? row.lastMessageAt.toISOString().slice(0, 10) : "дата неизвестна";
    console.log(
      `${apply ? "ЗАПИСЬ" : "НАЙДЕН"}: ${who} · ${row.channel} · ${when} · полей: ${filled}` +
        (draft.phone ? ` · тел: ${draft.phone}` : "")
    );

    if (apply) {
      // Тот же путь, что у бота: допуск и накопление полей считаются одним кодом.
      const recorded = await recordJobApplication({
        conversationId: row.id,
        channel: row.channel,
        contactName: row.contactName,
        draft,
      });
      // recordJobApplication глотает сбой и сообщает его результатом: раньше проход считал
      // «записанной» и анкету, которой в базе нет (HELPER-FINAL02).
      if (recorded) written++;
      else writeFailed++;
    }
  }

  const found = candidates.length - notJob - empty - aiFailed;
  console.log(
    `\nИтог: ${apply ? `записано анкет — ${written}${writeFailed > 0 ? `, НЕ записано из-за сбоя — ${writeFailed}` : ""}` : `нашлось анкет — ${found}`}; ` +
      `не про работу или без данных — ${notJob + empty}.`
  );
  if (aiFailed > 0) {
    // Непрочитанные переписки — не «кандидатов нет». Отдельной строкой, а код
    // возврата ставит обёртка main(): функцию зовут и из теста, ей чужой
    // process.exitCode портить нельзя.
    console.log(
      `ИИ не ответил по ${aiFailed} переписке(ам) — они НЕ разобраны и НЕ значат «не про работу». ` +
        "Запустите скрипт ещё раз, когда ИИ отвечает."
    );
  }
  if (!apply) console.log("Ничего не записано (нет --apply).");

  return {
    scanned: rows.length,
    alreadyRecorded: rows.filter((r) => recorded.has(r.id)).length,
    candidates: candidates.length,
    written,
    writeFailed,
    notJob,
    empty,
    aiFailed,
    stoppedOnAiFailures: stopped,
  };
}

async function main(): Promise<void> {
  const stats = await backfillJobApplications({ apply: APPLY, limit: LIMIT });
  if (stats.aiFailed > 0) process.exitCode = 1;
}

/**
 * Запуск только напрямую. Файл лежит в src/lib и попадает в сборку — без этой
 * проверки любой `import` из него запускал бы разбор архива прямо на старте
 * веб-сервера (тот же приём, что в lib/backfillInstagramUrls.ts и prisma/seed.ts).
 */
// Сравнение идёт через pathToFileURL, а не склейкой `file://` + путь: на Windows
// argv[1] выглядит как D:\CRM\... и голая склейка не совпадает с import.meta.url
// никогда — скрипт молча ничего не делал (поймано прогоном 03.09.2026).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error("Добор анкет прерван:", err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
