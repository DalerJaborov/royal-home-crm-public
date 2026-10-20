/**
 * НОЧНОЙ ПОИСК ДВОЙНЫХ ДОСЬЕ ПО СЛАБЫМ ПРИЗНАКАМ (план от 20.09.2026, §5.3).
 *
 * Точные признаки код ловит сразу, на входящем сообщении: один и тот же номер в
 * разных каналах (`TRANSPORT_SPLIT`), названный в переписке номер другого досье
 * (`STATED_PHONE`). Слабые признаки в горячем пути не годятся, и это не вопрос
 * скорости: «Далер» и «Умед» в Душанбе носят разные люди, а склеенные досье двух
 * человек означают чужой бюджет и чужой адрес в ответе бота — худшая ошибка из
 * всех, на какие способно досье.
 *
 * Поэтому здесь ровно два дела и ни одного решения:
 *
 *  1. найти пары, похожие по слабым признакам, и положить их ПРЕДЛОЖЕНИЕМ в ту же
 *     очередь, которую разбирает человек (`ContactLinkCandidate`);
 *  2. остановиться, когда предложений за ночь набралось достаточно.
 *
 * Слить два досье эта задача не может вовсе — `mergeContactProfiles` отсюда не
 * зовётся. Автоматика по слабому признаку была бы необратимой ошибкой, которую
 * никто не заметит: бот просто начнёт отвечать не тому человеку.
 *
 * Тумблер «Ночной поиск двойных досье» (Настройки → Бот) ВЫКЛЮЧЕН по умолчанию:
 * насколько смело искать — решение владельца.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { proposeContactLink } from "./contactProfiles.js";
import { loadStaffPhoneChecker } from "./staffPhoneGuard.js";
import { logSystemError } from "./systemError.js";

/**
 * СКОЛЬКО ПРЕДЛОЖЕНИЙ ЗА ОДНУ НОЧЬ.
 *
 * Предел, а не «сколько найдётся»: очередь разбирает человек, и триста
 * предложений в ней означают, что её не разберут вовсе — то же самое, что не
 * искать. Остаток найдётся следующей ночью, и порядок при этом устойчивый
 * (по времени последнего касания): свежие пары разбираются раньше.
 */
export const SWEEP_LIMIT = 50;

/**
 * СКОЛЬКО ЦИФР НОМЕРА СЧИТАЕМ «ПОХОЖИМ ХВОСТОМ» — семь из девяти.
 *
 * Меньше — и в одну кучу попадут незнакомые люди (шесть цифр совпадают у
 * каждого трёхсотого номера полосы). Больше — признак вырождается в точное
 * совпадение, которое и так ловится сразу на входящем, без ночной задачи.
 * Число из плана (§5.3), и оно намеренно живёт здесь одной константой, а не
 * настройкой: подбирать его в интерфейсе означало бы предлагать владельцу
 * решать задачу, у которой нет видимого ему условия.
 */
export const PHONE_TAIL_DIGITS = 7;

export interface ContactLinkSweepStats {
  /** Сколько пар нашли по имени вместе с хвостом номера. */
  nameAndDigits: number;
  /** Сколько пар нашли по одному нику в разных мессенджерах. */
  username: number;
  /** Сколько предложений в самом деле легло в очередь (остальные уже были там
   *  или уже разобраны человеком — `proposeContactLink` второй раз не пишет). */
  proposed: number;
  /** Тумблер выключен — задача не искала ничего. */
  skipped: boolean;
}

/**
 * В группе есть хотя бы одна пара, которой ещё нет в очереди (аудит Codex 04.10,
 * CHANNEL-NEW-06). Известные пары исключаются ДО `LIMIT`: иначе 50 уже предложенных
 * (или отклонённых человеком) групп, самых свежих по касанию, закрывали выдачу
 * навсегда, и новая пара не доходила до проверки каждую ночь. Сравнение id по
 * `COLLATE "C"` — тот же порядок, что у `ordered()` и `proposeContactLink` в JS
 * (посимвольный), а не по локали базы, которая игнорирует дефисы.
 */
const HAS_UNKNOWN_PAIR = Prisma.sql`EXISTS (
  SELECT 1
  FROM unnest(g.ids) AS a(x)
  JOIN unnest(g.ids) AS b(y) ON a.x COLLATE "C" < b.y COLLATE "C"
  WHERE NOT EXISTS (
    SELECT 1 FROM "ContactLinkCandidate" c WHERE c."leftId" = a.x AND c."rightId" = b.y
  )
)`;

/** Пара досье, найденная слабым признаком. */
interface Pair {
  leftId: string;
  rightId: string;
  reason: "NAME_AND_DIGITS" | "USERNAME";
  evidence: Record<string, unknown>;
}

/**
 * ОДИНАКОВОЕ ИМЯ ВМЕСТЕ С ПОХОЖИМ ХВОСТОМ НОМЕРА.
 *
 * Оба признака обязательны: имя само по себе не значит ничего (прямое
 * наблюдение владельца), а похожий хвост в одиночку — это сосед по полосе
 * номеров. Группируем в базе, а не в памяти: досье заводится на каждого
 * написавшего, и через год их будут десятки тысяч — вычитывать их все, чтобы
 * сравнить попарно, значит написать задачу, которая однажды не закончится.
 *
 * Имя сравнивается приведённым к нижнему регистру и без лишних пробелов. Имена
 * из профиля канала (`nameSource = "profile"`) НЕ участвуют: это подпись
 * аккаунта, она повторяется у разных людей и меняется когда вздумается.
 */
async function pairsByNameAndDigits(): Promise<Pair[]> {
  const rows = await prisma.$queryRaw<
    Array<{ name: string; tail: string; ids: string[]; last: Date }>
  >`
    WITH phones AS (
      SELECT
        p.id,
        lower(btrim(p."displayName")) AS name,
        right(i.value, ${PHONE_TAIL_DIGITS}) AS tail,
        p."lastSeenAt" AS last
      FROM "ContactProfile" p
      JOIN "ContactIdentity" i ON i."profileId" = p.id AND i.kind = 'PHONE'
      WHERE p."mergedIntoId" IS NULL
        AND p.category <> 'SPAM'
        AND p."displayName" IS NOT NULL
        AND btrim(p."displayName") <> ''
        AND coalesce(p."nameSource", '') <> 'profile'
        AND length(i.value) >= ${PHONE_TAIL_DIGITS}
    )
    , grouped AS (
      SELECT name, tail, array_agg(DISTINCT id) AS ids, max(last) AS last
      FROM phones
      GROUP BY name, tail
      HAVING count(DISTINCT id) > 1
    )
    SELECT name, tail, ids, last
    FROM grouped g
    WHERE ${HAS_UNKNOWN_PAIR}
    ORDER BY last DESC
    LIMIT ${SWEEP_LIMIT}
  `;
  return rows.flatMap((row) =>
    combine(row.ids).map(([leftId, rightId]) => ({
      leftId,
      rightId,
      reason: "NAME_AND_DIGITS" as const,
      evidence: { name: row.name, tailDigits: PHONE_TAIL_DIGITS },
    }))
  );
}

/**
 * ОДИН И ТОТ ЖЕ НИК В РАЗНЫХ МЕССЕНДЖЕРАХ.
 *
 * Внутри одного вида идентичности двух досье с одним ником не бывает вовсе
 * (уникальность пары «вид + значение» в базе это и гарантирует), поэтому
 * признак работает только между видами: @ivan в Telegram и @ivan в Instagram.
 * Слабый по природе — ники повторяются, — но у вернувшегося человека он часто
 * единственный: номер он не называл ни там, ни там.
 */
async function pairsByUsername(): Promise<Pair[]> {
  const rows = await prisma.$queryRaw<Array<{ handle: string; ids: string[]; last: Date }>>`
    WITH handles AS (
      SELECT p.id, lower(btrim(i.value)) AS handle, p."lastSeenAt" AS last
      FROM "ContactProfile" p
      JOIN "ContactIdentity" i ON i."profileId" = p.id
      WHERE p."mergedIntoId" IS NULL
        AND p.category <> 'SPAM'
        AND i.kind IN ('TG_USERNAME', 'IG_USERNAME')
        AND btrim(i.value) <> ''
    )
    , grouped AS (
      SELECT handle, array_agg(DISTINCT id) AS ids, max(last) AS last
      FROM handles
      GROUP BY handle
      HAVING count(DISTINCT id) > 1
    )
    SELECT handle, ids, last
    FROM grouped g
    WHERE ${HAS_UNKNOWN_PAIR}
    ORDER BY last DESC
    LIMIT ${SWEEP_LIMIT}
  `;
  return rows.flatMap((row) =>
    combine(row.ids).map(([leftId, rightId]) => ({
      leftId,
      rightId,
      reason: "USERNAME" as const,
      evidence: { username: row.handle },
    }))
  );
}

/**
 * Пара хранится упорядоченной (меньший id слева) — так же, как её пишет
 * `proposeContactLink`. Приводим к тому же виду ДО запроса «что уже известно»:
 * иначе половина пар пришла бы стороной, которой в базе нет, и каждая ночь
 * заводила бы их заново.
 */
function ordered(pairs: Pair[]): Pair[] {
  return pairs.map((p) =>
    p.leftId < p.rightId ? p : { ...p, leftId: p.rightId, rightId: p.leftId }
  );
}

/** Все пары из группы. Групп по три и больше почти не бывает, но «почти» —
 *  не «никогда», и терять третьего было бы тихой потерей. */
function combine(ids: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) pairs.push([ids[i], ids[j]]);
  }
  return pairs;
}

/**
 * НОМЕРА, КОТОРЫЕ НЕ ДЕЛАЮТ ЛЮДЕЙ ОДНИМ ЧЕЛОВЕКОМ (план §5.2 п. 5).
 *
 * Номер сотрудника в досье — это агент, писавший клиенту со своего телефона, и
 * по нему «сходятся» все клиенты подряд. Проверяется одним запросом на весь
 * прогон, а не в цикле: тот же приём, что в приёме лида и импорте.
 */
async function withoutStaffPhones(pairs: Pair[]): Promise<Pair[]> {
  const nameAndDigits = pairs.filter((p) => p.reason === "NAME_AND_DIGITS");
  if (nameAndDigits.length === 0) return pairs;
  const ids = [...new Set(nameAndDigits.flatMap((p) => [p.leftId, p.rightId]))];
  const [identities, isStaff] = await Promise.all([
    prisma.contactIdentity.findMany({
      where: { profileId: { in: ids }, kind: "PHONE" },
      select: { profileId: true, value: true },
    }),
    loadStaffPhoneChecker(),
  ]);
  const staffProfiles = new Set(
    identities.filter((i) => isStaff([i.value])).map((i) => i.profileId)
  );
  if (staffProfiles.size === 0) return pairs;
  return pairs.filter(
    (p) => p.reason !== "NAME_AND_DIGITS" || (!staffProfiles.has(p.leftId) && !staffProfiles.has(p.rightId))
  );
}

/**
 * Один ночной прогон. Отказ любой части не роняет крон и попадает в журнал
 * ошибок: очередь предложений — не тот механизм, ради которого стоит будить
 * человека ночью, а молча потерянный отказ — то, из-за чего задача однажды
 * перестаёт работать незамеченной.
 */
export async function runContactLinkSweepTick(): Promise<ContactLinkSweepStats> {
  const stats: ContactLinkSweepStats = { nameAndDigits: 0, username: 0, proposed: 0, skipped: false };
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { contactLinkSweepEnabled: true },
    });
    if (!settings?.contactLinkSweepEnabled) {
      stats.skipped = true;
      return stats;
    }

    const [byName, byUsername] = await Promise.all([pairsByNameAndDigits(), pairsByUsername()]);
    stats.nameAndDigits = byName.length;
    stats.username = byUsername.length;

    // Ник — признак более узкий, чем имя с хвостом номера, поэтому при упоре в
    // предел за ночь он попадает в очередь первым, а не теряется в хвосте.
    const pairs = await withoutStaffPhones([...byUsername, ...byName]).then(ordered);

    /**
     * Что уже в очереди или уже разобрано — ОДНИМ запросом на весь прогон.
     * `proposeContactLink` и сам не пишет второй раз, но молча, и по его
     * молчанию не отличить «завели» от «уже было»; счёт же в журнале нужен
     * честный. Спрашивать по паре в цикле — это запрос на каждую находку, тот
     * самый N+1, который в этом репозитории ищут глазами при каждой правке.
     */
    // Пустой OR в Prisma означает «без условия», то есть ВСЮ таблицу: на пустой
    // находке в базу не идём вовсе.
    if (pairs.length === 0) return stats;
    const known = new Set(
      (
        await prisma.contactLinkCandidate.findMany({
          where: { OR: pairs.map(({ leftId, rightId }) => ({ leftId, rightId })) },
          select: { leftId: true, rightId: true },
        })
      ).map((row) => `${row.leftId}:${row.rightId}`)
    );

    // Известные отбрасываются ДО предела, а не после: иначе они расходовали бы его впустую.
    const fresh = pairs.filter((pair) => !known.has(`${pair.leftId}:${pair.rightId}`));
    for (const pair of fresh.slice(0, SWEEP_LIMIT)) {
      await proposeContactLink(pair);
      stats.proposed += 1;
    }
    return stats;
  } catch (err) {
    void logSystemError(
      "contact-profile",
      `ночной поиск двойных досье не прошёл: ${(err as Error).message}`,
      { stack: (err as Error).stack, dedupKey: "contact-link-sweep" }
    );
    return stats;
  }
}
