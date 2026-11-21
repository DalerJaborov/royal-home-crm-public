/** Опечатко-устойчивый поиск поверх токенизации из lib/searchTokens.ts.
 *
 * searchTokens.ts переживает порядок слов, забытую раскладку, латиницу и
 * таджикскую диакритику — но не переживает саму ОПЕЧАТКУ или гласную-вариацию
 * написания: «воданасос» и «ваданасос» это разные строки для ILIKE, хотя одно
 * и то же слово на слух. Требование владельца (docs/lead-lifecycle-plan.md,
 * второй пакет, п.5) — сделать поиск устойчивым и к этому.
 *
 * Решение — расширение Postgres pg_trgm (триграммы + similarity()), а не
 * замена токенного поиска: токенный поиск дешевле и точнее, когда написание
 * совпадает буква-в-букву, и обязан оставаться первым слоем. pg_trgm
 * подключается ТОЛЬКО как fallback, когда токенный поиск не нашёл ничего —
 * иначе типичный точный запрос («Рудаки 45») стал бы платить лишним проходом
 * по индексу на каждый вызов списка.
 *
 * Порог similarity > 0.3 — стандартная рекомендация pg_trgm для «слово
 * набрано с опечаткой», проверено на паре «воданасос»/«ваданасос»
 * (similarity ≈ 0.36 для этой конкретной пары — выше порога).
 */
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { toSearchTokens } from "./searchTokens.js";
import { noteLength, stripClientNoteLabels, stripClientNoteLabelsSql } from "./clientNoteLabels.js";

export const FUZZY_SIMILARITY_THRESHOLD = 0.3;

/** Максимум кандидатов из fallback-прохода — список всё равно постранично
 *  фильтруется/сортируется дальше обычным путём, тащить больше не нужно. */
const FUZZY_CANDIDATE_LIMIT = 200;

/**
 * Условие для ОДНОГО слова запроса на одном текстовом поле: слово похоже на
 * КАКОЙ-ТО фрагмент внутри поля, а не на поле целиком.
 *
 * `similarity(column, token)` сравнивает строки целиком и почти всегда
 * низкая, когда токен — одно слово, а поле — «улица, дом» или «ФИО из двух
 * слов»: разная длина топит меру совпадения даже при точном совпадении
 * нужного слова внутри. `word_similarity(token, column)` — правильная
 * функция pg_trgm именно для этого: ищет наиболее похожий фрагмент ВНУТРИ
 * более длинной строки. ILIKE-подстрока остаётся страховкой для коротких
 * точных токенов (цифры), где триграммное сходство ненадёжно.
 */
function tokenCondition(column: Prisma.Sql, token: string): Prisma.Sql {
  return Prisma.sql`(${column} %> ${token} OR ${column} ILIKE ${"%" + token + "%"})`;
}

/**
 * ОПЕРАТОР, А НЕ ФУНКЦИЯ — иначе индексы, ради которых всё затевалось, лежат мёртвым
 * грузом (аудит 09.08.2026). `gin_trgm_ops` обслуживает ОПЕРАТОРЫ (`%>`, `<%`, `%`,
 * ILIKE), а вызов `word_similarity(a, b) > 0.3` планировщик в оператор не переписывает:
 * проверено на живой базе — с функцией план `Seq Scan`, с `%>` — `Bitmap Index Scan`
 * по `Client_fullName_trgm_idx`. Три GIN-индекса при этом занимали место и замедляли
 * запись, не обслуживая ни одного запроса.
 *
 * Порог у оператора берётся не из выражения, а из настройки сессии, поэтому его
 * приходится выставлять перед запросом (см. withThreshold). Умолчание Postgres — 0.6,
 * то есть без этой установки поиск молча стал бы строже нашего 0.3 и перестал бы
 * находить те самые опечатки, ради которых он есть.
 */
async function fuzzyIds(query: Prisma.Sql): Promise<string[]> {
  // Число подставляется в текст запроса (SET не принимает параметры-бинды), но оно
  // наше собственное и константное — пользовательские данные сюда не доходят.
  const threshold = Prisma.raw(String(FUZZY_SIMILARITY_THRESHOLD));
  const rows = await prisma.$transaction(async (tx) => {
    // LOCAL — значит «до конца транзакции»: соседние запросы в пуле соединений
    // не должны унаследовать наш порог.
    await tx.$executeRaw(Prisma.sql`SET LOCAL pg_trgm.word_similarity_threshold = ${threshold}`);
    return tx.$queryRaw<Array<{ id: string }>>(query);
  });
  return rows.map((r) => r.id);
}

/**
 * Объекты: ищем похожие слова в названии и адресе — те же два поля, что и у
 * основного токенного поиска в routes/properties.ts.
 *
 * ВАЖНО: как и у основного токенного поиска, здесь требуются ВСЕ слова запроса
 * (AND между токенами), а не хотя бы одно — иначе двусловный запрос вроде
 * «Рудаки Махмудова» находил бы по отдельности любой из двух разных адресов,
 * хотя ни один не содержит оба слова (см. property-search.test.ts, «найтись
 * должны все слова, а не любое из них» — гарантия обязана пережить и fallback,
 * не только основной токенный поиск).
 */
export async function fuzzyPropertyIds(query: string): Promise<string[]> {
  const tokens = toSearchTokens(query);
  if (tokens.length === 0) return [];
  const perTokenAcrossFields = tokens.map(
    (token) => Prisma.sql`(${tokenCondition(Prisma.sql`title`, token)} OR ${tokenCondition(Prisma.sql`address`, token)})`,
  );
  const whereTokens = Prisma.join(perTokenAcrossFields, " AND ");
  // Сортировка по similarity индексом не обслуживается (для этого нужен GiST и
  // оператор <->), но она применяется уже к отобранным кандидатам — их не больше
  // сотни-другой, и на этом объёме считать меру дешевле, чем содержать второй
  // индекс ради порядка выдачи.
  return fuzzyIds(Prisma.sql`
    SELECT id FROM "Property"
    WHERE "deletedAt" IS NULL AND (${whereTokens})
    ORDER BY GREATEST(similarity(title, ${query.trim()}), similarity(address, ${query.trim()})) DESC
    LIMIT ${FUZZY_CANDIDATE_LIMIT}
  `);
}

/** Клиенты: ищем похожие слова в ФИО — единственное текстовое поле основного
 *  поиска (routes/clients.ts); телефон намеренно не участвует, цифрам
 *  опечатко-устойчивость не нужна, там нужен точный номер.
 *
 *  Та же гарантия «все слова обязательны», что и у объектов выше. */
export async function fuzzyClientIds(query: string): Promise<string[]> {
  const tokens = toSearchTokens(query);
  if (tokens.length === 0) return [];
  const perToken = tokens.map((token) => tokenCondition(Prisma.sql`"fullName"`, token));
  const whereTokens = Prisma.join(perToken, " AND ");
  return fuzzyIds(Prisma.sql`
    SELECT id FROM "Client"
    WHERE "deletedAt" IS NULL AND (${whereTokens})
    ORDER BY similarity("fullName", ${query.trim()}) DESC
    LIMIT ${FUZZY_CANDIDATE_LIMIT}
  `);
}

/**
 * ПОХОЖИЕ ОПИСАНИЯ ОБЪЕКТА/ЗАПРОСА (19.08.2026) — не опечатко-устойчивый поиск по
 * запросу пользователя, а сравнение ДВУХ уже сохранённых текстов между собой:
 * владелец заметил, что один и тот же продавец мог написать в чат и позвонить с
 * другого номера, и «Заметки» обеих карточек в таком случае почти дословно
 * совпадают («квартира переделана в 3-комнатную на 17 этаже… напротив Театра
 * кукол») — это сильный сигнал «один человек», который не ловит проверка по
 * телефону/Telegram (routes/clients.ts: POST /merge).
 *
 * Порог заметно выше обычного (0.5 против 0.3): это не подсказка «может, опечатка»,
 * а предложение слить две карточки — ложное срабатывание здесь стоит дороже, чем
 * у обычного поиска, поэтому требуем «очень высокую вероятность» (формулировка
 * владельца), а не любое частичное сходство.
 *
 * `similarity()` без индекса — не `%>`/GiST: сравнение идёт не с константным
 * запросом, а попарно между текстами в самой таблице, KNN-индекс здесь не
 * применить. На объёме в сотни клиентов с непустыми заметками это дёшево;
 * если база вырастет на порядки, потребуется отдельный подход (то же
 * предупреждение, что у DUPLICATES_SCAN_LIMIT в routes/clients.ts).
 */
export interface SimilarNotesCandidate {
  id: string;
  similarity: number;
}

/**
 * Служебные строки бота в заметках («🏷 ПРОДАВЕЦ — …», «🌍 ВНЕ ДУШАНБЕ — клиент назвал
 * «…»», «📞 ПРОСИТ ПЕРЕЗВОНИТЬ: …») одинаковы у десятков разных людей и не должны
 * считаться сходством (живые случаи владельца 24.08.2026 — «55-59%» у четырёх разных
 * продавцов, и 21.11.2026 — «82-84%» у трёх разных «Прочих обращений»). Что считается
 * служебным — ОДИН список в lib/clientNoteLabels.ts; здесь он только применяется: к
 * тексту открытой карточки в JS и к кандидатам в самой таблице — той же регуляркой в
 * Postgres (равенство обеих сторон сверяет тест на живой базе).
 *
 * Короче SIMILAR_NOTES_MIN_LENGTH остаток заметок — не «уникальное содержание», а общая
 * фраза пересказа («Клиент ищет дом»): у двух разных людей она совпадает дословно, и
 * similarity даёт 100%. Живой случай, ради которого подсказка задумана, — подробное
 * описание объекта (сто знаков и больше). Длина — в кодовых точках, как length() в Postgres.
 */
export const SIMILAR_NOTES_MIN_LENGTH = 40;

export async function fuzzySimilarClientNotes(
  clientId: string,
  notes: string,
  // Порог поднят с 0.5 (владелец 24.08.2026, после того как ярлыки перестали
  // считаться сходством — прежний порог был откалиброван ПОД их шум и без
  // него стал бы слишком мягким): предложение слить карточки — это заведомо
  // редкое и уверенное совпадение, а не «может быть, похоже».
  threshold = 0.65,
  limit = 3,
  // Пары «это разные люди» (Client.dismissedSimilarClientIds) отсекаются ДО
  // LIMIT: иначе три отклонённые пары занимали бы все места и закрывали
  // четвёртую, настоящую.
  excludeIds: string[] = []
): Promise<SimilarNotesCandidate[]> {
  const trimmed = stripClientNoteLabels(notes);
  if (noteLength(trimmed) < SIMILAR_NOTES_MIN_LENGTH) return [];
  const stripped = stripClientNoteLabelsSql(Prisma.sql`"requirementsNotes"`);
  return prisma.$queryRaw<SimilarNotesCandidate[]>(Prisma.sql`
    SELECT id, similarity
    FROM (
      SELECT id, ${stripped} AS rest
      FROM "Client"
      WHERE "deletedAt" IS NULL
        AND id != ${clientId}
        AND id <> ALL(${excludeIds}::text[])
        AND "requirementsNotes" IS NOT NULL
        AND "requirementsNotes" != ''
    ) c
    CROSS JOIN LATERAL (SELECT similarity(c.rest, ${trimmed}) AS similarity) s
    WHERE length(c.rest) >= ${SIMILAR_NOTES_MIN_LENGTH}
      AND s.similarity > ${threshold}
    ORDER BY s.similarity DESC
    LIMIT ${limit}
  `);
}
