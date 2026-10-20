import { prisma, type TxClient } from "../db.js";

/**
 * ВСЕ НОМЕРА КЛИЕНТА В ОДНОМ МЕСТЕ (18.08.2026).
 *
 * До этого дня у клиента был ровно один номер для узнавания — `Client.phone`
 * (плюс `whatsappPhone` как адрес переписки). Оба живых случая, из-за которых
 * появился этот модуль, ломали ровно это допущение:
 *
 *  1. Продавец прислал боту ЧЕТЫРЕ номера столбиком. В карточку попал один,
 *     остальные агент записал ТЕКСТОМ в заметки («Другие номера, которые оставил
 *     клиент: …»). Человек это прочтёт, система — нет: звонок со второго номера
 *     проходит мимо карточки.
 *  2. У клиента кончились деньги на симке, он позвонил со второй. CRM не узнала
 *     его, завела новую карточку и отдала ДРУГОМУ агенту — то есть увела клиента
 *     у того, кто его вёл.
 *
 * Ценность этого модуля вся в первом гудке: узнавание должно случиться ДО ответа,
 * без ИИ и без второго запроса. Поэтому поиск — один SQL по всем трём источникам
 * номера сразу, а не три обращения подряд и не join по отдельной таблице.
 *
 * ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ: по какому номеру ЗВОНИТЬ. Звоним всегда по `phone` —
 * `extraPhones` существуют только для узнавания входящего (см. комментарий у поля
 * в schema.prisma и CallClientButton на веб-клиенте).
 */

/**
 * Сколько последних цифр считаем «тем же номером». Девять — потому что столько в
 * любом здешнем номере, а код страны записан как попало: со станции приходит
 * «940001011», из формы сайта «+992940001011», руками — «992 94 000 10 11».
 * Ровно это правило уже работает в lib/telephony (`sameNumber` в ariEvents.ts,
 * localDialDigits в failoverSync.ts) и в дедупликации клиентов — своё
 * пятое сравнение номеров развело бы CRM саму с собой.
 */
export const PHONE_TAIL_LEN = 9;

/** Последние 9 цифр номера — то, чем он узнаётся независимо от формы записи. */
export function phoneTail(phone: string): string {
  return (phone ?? "").replace(/\D/g, "").slice(-PHONE_TAIL_LEN);
}

/** Годен ли номер для поиска: короче девяти цифр — не номер, а обрывок. */
export function hasSearchableTail(phone: string): boolean {
  return phoneTail(phone).length === PHONE_TAIL_LEN;
}

/**
 * Убирает повторы и всё, что совпадает с уже известными номерами карточки.
 * Сравнение — по хвосту, а не по строке: «+992940001011» и «940001011» это один
 * номер, и хранить обе записи значило бы показать агенту два «разных» телефона.
 * Порядок сохраняется — первым человек обычно называет главный.
 */
export function dedupePhones(phones: readonly string[], exclude: readonly (string | null | undefined)[] = []): string[] {
  const seen = new Set(exclude.filter(Boolean).map((p) => phoneTail(p as string)).filter(Boolean));
  const out: string[] = [];
  for (const phone of phones) {
    const tail = phoneTail(phone);
    if (tail.length < PHONE_TAIL_LEN || seen.has(tail)) continue;
    seen.add(tail);
    out.push(phone);
  }
  return out;
}

/** Где именно совпал номер — нужно и для сообщения об ошибке, и для приоритета. */
export type PhoneMatchField = "phone" | "extra" | "whatsapp";

export interface PhoneOwnerRow {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  whatsappPhone: string | null;
  extraPhones: string[];
  deletedAt: Date | null;
  assignedAgentId: string | null;
}

/**
 * Все карточки, которым принадлежит хоть один из переданных номеров, — ОДНИМ
 * запросом на весь список. Отдельный запрос на номер дал бы N+1 ровно там, где
 * его цена максимальна: бот сохраняет четыре номера сразу, а входящий звонок
 * вообще не имеет права ждать.
 *
 * `includeDeleted` по умолчанию false: карточка в Корзине не должна ни отвечать
 * на звонок, ни запрещать агенту вписать номер. Исключение — узнавание входящего
 * сообщения (findClientByPhoneDigits), где Корзину надо УВИДЕТЬ, чтобы воскресить
 * карточку штатным путём вместо создания дубликата.
 *
 * Порядок: сначала совпадение по главному номеру (это «настоящий» владелец),
 * потом по запасным, потом по WhatsApp; внутри — самая ранняя карточка. Тот же
 * принцип «при дубликатах берём первую» уже был в findClientByPhoneDigits.
 *
 * LIMIT стоит всегда: выборка возвращает массив, а значит обязана иметь предел.
 *
 * Две мелочи SQL, каждая из которых уже роняла запрос и поймана тестом:
 *  - длина хвоста идёт с `::int` — Prisma шлёт числа как bigint, а функции
 *    `right(text, bigint)` в Postgres нет;
 *  - `extraPhones` читается через coalesce — у карточек, заведённых ДО миграции,
 *    в колонке лежит NULL, и `.some(...)` по нему падал.
 */
export async function findPhoneOwners(
  phones: readonly string[],
  opts: { includeDeleted?: boolean; exceptClientId?: string; limit?: number; db?: Pick<TxClient, "$queryRaw"> } = {}
): Promise<(PhoneOwnerRow & { matchedIn: PhoneMatchField })[]> {
  const tails = [...new Set(phones.map(phoneTail).filter((t) => t.length === PHONE_TAIL_LEN))];
  if (tails.length === 0) return [];
  const limit = opts.limit ?? 20;
  const except = opts.exceptClientId ?? "";
  const includeDeleted = opts.includeDeleted ?? false;

  return (opts.db ?? prisma).$queryRaw<(PhoneOwnerRow & { matchedIn: PhoneMatchField })[]>`
    SELECT "id", "shortId", "fullName", "phone", "whatsappPhone",
           coalesce("extraPhones", ARRAY[]::text[]) AS "extraPhones",
           "deletedAt", "assignedAgentId",
           CASE
             WHEN right(regexp_replace("phone", '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails}) THEN 'phone'
             WHEN EXISTS (
               SELECT 1 FROM unnest(coalesce("extraPhones", ARRAY[]::text[])) AS p
               WHERE right(regexp_replace(p, '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails})
             ) THEN 'extra'
             ELSE 'whatsapp'
           END AS "matchedIn"
    FROM "Client"
    WHERE (${includeDeleted} OR "deletedAt" IS NULL)
      AND "id" <> ${except}
      AND (
        right(regexp_replace("phone", '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails})
        OR right(regexp_replace(coalesce("whatsappPhone", ''), '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails})
        OR EXISTS (
          SELECT 1 FROM unnest(coalesce("extraPhones", ARRAY[]::text[])) AS p
          WHERE right(regexp_replace(p, '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails})
        )
      )
    ORDER BY
      -- ЖИВАЯ КАРТОЧКА ВСЕГДА РАНЬШЕ УДАЛЁННОЙ (аудит №4, 27.08). Раньше сортировка
      -- начиналась с «главный номер раньше запасного», и после слияния дубликатов
      -- карточка из Корзины (она сохраняет свой ГЛАВНЫЙ номер) обгоняла живую, к
      -- которой номер только что переехал запасным: сообщение с этого номера
      -- воскрешало пустую оболочку и отменяло слияние.
      CASE WHEN "deletedAt" IS NULL THEN 0 ELSE 1 END,
      CASE
        WHEN right(regexp_replace("phone", '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails}) THEN 0
        WHEN EXISTS (
          SELECT 1 FROM unnest(coalesce("extraPhones", ARRAY[]::text[])) AS p
          WHERE right(regexp_replace(p, '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = ANY(${tails})
        ) THEN 1
        ELSE 2
      END, "createdAt" ASC
    LIMIT ${limit}`;
}

/**
 * Что из найденных ботом номеров действительно можно записать карточке в запасные.
 *
 * Отличие от ручного ввода агентом принципиальное: агент ОШИБСЯ и должен об этом
 * узнать (см. findPhoneConflicts и routes/clients.ts), а бот просто разобрал чужой
 * текст — и падать на этом приёму сообщения нельзя. Поэтому здесь занятые чужой
 * карточкой номера молча отбрасываются: заявка важнее запасного телефона.
 *
 * Отбрасываем также главный и whatsapp-номер самой карточки (дубликат в списке
 * выглядел бы как второй телефон, которого нет) и то, что там уже записано.
 */
export async function pickFreeExtraPhones(
  candidates: readonly string[],
  ctx: {
    clientId?: string;
    phone?: string | null;
    whatsappPhone?: string | null;
    existing?: readonly string[];
    /** Карточки, чьи номера не считаются занятыми: при слиянии это сам дубль,
     *  который через миг уйдёт в Корзину и отдаёт номера основной карточке. */
    releasingClientIds?: readonly string[];
  }
): Promise<string[]> {
  const wanted = dedupePhones(candidates, [ctx.phone, ctx.whatsappPhone, ...(ctx.existing ?? [])]);
  if (wanted.length === 0) return [];
  const releasing = new Set(ctx.releasingClientIds ?? []);
  const conflicts = (await findPhoneConflicts(wanted, ctx.clientId)).filter((c) => !releasing.has(c.clientId));
  const taken = new Set(conflicts.map((c) => phoneTail(c.phone)));
  return wanted.filter((p) => !taken.has(phoneTail(p)));
}

export interface PhoneConflict {
  /** Номер ИЗ ЗАПРОСА, который оказался занят — его и подсвечивает форма. */
  phone: string;
  clientId: string;
  shortId: number;
  fullName: string;
  /** true — номер записан у того клиента ГЛАВНЫМ, false — запасным/WhatsApp. */
  isPrimary: boolean;
  assignedAgentId: string | null;
}

/**
 * ОДИН НОМЕР — ОДИН ХОЗЯИН. Проверка перед тем, как записать номера в карточку.
 *
 * Почему это вообще нужно, хотя `Client.phone` уникален: уникальность в базе
 * стоит только на ГЛАВНОМ номере. Без этой проверки агент мог бы вписать себе в
 * запасные чужой главный номер — и входящий звонок начал бы находить ДВЕ карточки,
 * то есть ровно ту неоднозначность, ради устранения которой всё и делалось. Причём
 * молча: узнали бы об этом по жалобе «звонок ушёл не тому».
 *
 * Возвращает СПИСОК, а не первый конфликт: агент, вставивший четыре номера из
 * заметок, должен увидеть все занятые сразу, а не исправлять их по одному.
 */
export async function findPhoneConflicts(
  phones: readonly string[],
  exceptClientId?: string
): Promise<PhoneConflict[]> {
  const owners = await findPhoneOwners(phones, { exceptClientId });
  if (owners.length === 0) return [];

  const conflicts: PhoneConflict[] = [];
  for (const phone of phones) {
    const tail = phoneTail(phone);
    if (tail.length < PHONE_TAIL_LEN) continue;
    // Перебор по уже загруженному списку, без похода в базу на каждый номер:
    // владельцев здесь единицы, а запрос был ровно один (см. findPhoneOwners).
    const owner = owners.find(
      (o) =>
        phoneTail(o.phone) === tail ||
        phoneTail(o.whatsappPhone ?? "") === tail ||
        o.extraPhones.some((p) => phoneTail(p) === tail)
    );
    if (!owner) continue;
    conflicts.push({
      phone,
      clientId: owner.id,
      shortId: owner.shortId,
      fullName: owner.fullName,
      isPrimary: phoneTail(owner.phone) === tail,
      assignedAgentId: owner.assignedAgentId,
    });
  }
  return conflicts;
}
