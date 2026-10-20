/**
 * ДОСЬЕ СОБЕСЕДНИКА — заводим и ведём карточку на каждого написавшего.
 *
 * Зачем (владелец 21.09.2026: «карточки на каждого написавшего сделать срочно,
 * это важнее всего»): всё, что бот знал о человеке, жило в черновике ОДНОГО
 * диалога и в переписке, обрезанной до 40 реплик. Тот же человек из другого
 * канала — новый незнакомец; вернулся через неделю — имя и номер спрашиваются
 * заново. `Client` не спасает: карточка появляется только у оформленного лида.
 *
 * ГЛАВНОЕ ПРАВИЛО СВЯЗЫВАНИЯ КАНАЛОВ, из-за которого этот модуль вообще написан
 * отдельно от всего остального: автоматически связывать разрешено ТОЛЬКО то, что
 * подтвердил сам канал (`TRANSPORT`). Напечатанный в чате номер (`STATED`) чужое
 * досье не сливает — он заводит кандидата на ручное подтверждение, потому что
 * продавец диктует номер жены, а агент пересылает чужой контакт. Склеенные досье
 * двух людей означают чужой бюджет и чужой адрес в ответе бота, и разобрать это
 * потом практически невозможно.
 *
 * Словарь (категории, виды идентификаторов, схема фактов) — общий с экраном:
 * `@royal-home/shared` → `packages/shared/src/contactProfile.ts`.
 * Разбор и решения: docs/contact-profile-and-bot-roles-20-09.md.
 */

import {
  CONTACT_IDENTITY_KINDS,
  contactCategoryLabel,
  dominantLanguage,
  emptyContactFacts,
  isContactCategory,
  parseContactCategoryHistory,
  parseContactFacts,
  readContactFacts,
  parseContactLanguageCounts,
  type ContactCategory,
  type ContactCategoryHistoryEntry,
  type ContactFact,
  type ContactFactDomain,
  type ContactIdentityKind,
  type ContactIdentityTrust,
  type ContactNameSource,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";

import { logSystemError } from "./systemError.js";
import { sanitizeSpokenName } from "./spokenName.js";
import { phoneTail } from "./clientPhones.js";
import { WHATSAPP_CHANNEL, whatsAppPhoneFromSubscriberId } from "./whatsappPhone.js";

/** Один идентификатор канала на входе. */
export interface ContactIdentityInput {
  kind: ContactIdentityKind;
  /** Сырое значение как его дал канал — нормализуем здесь, а не у вызывающего. */
  value: string | null | undefined;
  trust: ContactIdentityTrust;
}

export interface ResolveContactProfileInput {
  /**
   * Идентификаторы этого касания. Хотя бы один обязан быть `TRANSPORT` — иначе
   * заводить досье не на чем: по одному напечатанному номеру нельзя ни узнать
   * человека, ни отличить его от того, чей номер он назвал.
   */
  identities: ContactIdentityInput[];
  /** Имя, если канал его сообщил. */
  name?: string | null;
  /** Откуда имя. Именем из профиля канала бот не обращается — см. словарь. */
  nameSource?: ContactNameSource;
}

export interface ResolvedContactProfile {
  profileId: string;
  /** true — досье завела именно эта попытка (первое касание человека вообще). */
  created: boolean;
}

/** Нормализованный идентификатор, готовый к записи. */
interface NormalizedIdentity {
  kind: ContactIdentityKind;
  value: string;
  trust: ContactIdentityTrust;
}

/**
 * Приведение значения к тому виду, в котором оно лежит в базе.
 *
 * Для `PHONE` это хвост из девяти цифр — ТОТ ЖЕ, каким CRM уже узнаёт клиента по
 * номеру (`lib/clientPhones.ts`). Свой вариант нормализации развёл бы
 * «+992 90 123-45-67» и «992901234567» в двух разных людей — ровно та поломка,
 * от которой досье и должно защищать.
 */
/**
 * КЛЮЧ ТЕЛЕФОНА В ДОСЬЕ — С КОДОМ СТРАНЫ, ЕСЛИ ОН НЕ ТАДЖИКСКИЙ (правка 22.09.2026).
 *
 * Ключом был просто хвост из девяти цифр — тот же, каким CRM узнаёт клиента по
 * номеру. Для здешних номеров это верно: код страны в базе записан как попало
 * («940001011», «+992940001011», «992 94 000 10 11»), и девять цифр — ровно
 * столько, сколько в местном номере.
 *
 * Но у досье цена ошибки другая. Хвост — признак `TRANSPORT`, то есть повод
 * связать каналы АВТОМАТИЧЕСКИ, без подтверждения человеком. А узбекский
 * `+998 90 123 45 67` и душанбинский `+992 90 123 45 67` дают один и тот же
 * хвост: память двух незнакомых людей склеивалась молча, и бот отвечал одному
 * бюджетом и адресом другого.
 *
 * Поэтому: местный номер (до девяти цифр или 992 + девять) по-прежнему
 * сводится к хвосту — старые записи продолжают находиться и ничего мигрировать
 * не нужно. Всё остальное хранится полностью, с кодом страны, и столкнуться уже
 * не может. Иностранные досье, заведённые ДО этой правки по хвосту, просто
 * перестанут находиться по номеру: человек получит новое досье вместо чужого —
 * потеря памяти лечится, склейка двух людей нет.
 */
function phoneIdentityValue(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  if (digits.length === 9) return digits;
  if (digits.length === 12 && digits.startsWith("992")) return phoneTail(digits);
  return digits;
}

function normalizeIdentityValue(kind: ContactIdentityKind, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (kind === "PHONE") return phoneIdentityValue(trimmed);
  if (kind === "TG_USERNAME" || kind === "IG_USERNAME") {
    // Ник регистронезависим и часто приходит с «@» — иначе «@Ali» и «ali» это
    // два разных человека.
    return trimmed.replace(/^@+/, "").toLowerCase() || null;
  }
  if (kind === "EMAIL") return trimmed.toLowerCase();
  return trimmed;
}

function normalizeIdentities(list: ContactIdentityInput[]): NormalizedIdentity[] {
  const out: NormalizedIdentity[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || !(CONTACT_IDENTITY_KINDS as readonly string[]).includes(item.kind)) continue;
    const raw = typeof item.value === "string" ? item.value : "";
    const value = normalizeIdentityValue(item.kind, raw);
    if (!value) continue;
    const key = `${item.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: item.kind, value, trust: item.trust });
  }
  return out;
}

/**
 * Дойти до досье, которое ОСТАЛОСЬ ЖИТЬ после слияний. Слитая запись не
 * удаляется (ссылки диалогов должны остаться рабочими), поэтому ссылка на неё
 * может прийти откуда угодно и обязана привести к живому досье.
 *
 * Предел шагов — не паранойя: цепочка строится ручными слияниями, и кольцо
 * (A → B → A) стоило бы бесконечного цикла в обработчике входящего сообщения.
 */
const MERGE_CHAIN_LIMIT = 10;

export async function resolveMergedInto(profileId: string): Promise<string> {
  let current = profileId;
  const seen = new Set<string>([current]);
  for (let step = 0; step < MERGE_CHAIN_LIMIT; step += 1) {
    const row = await prisma.contactProfile.findUnique({
      where: { id: current },
      select: { mergedIntoId: true },
    });
    const next = row?.mergedIntoId;
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * НАЙТИ ИЛИ ЗАВЕСТИ ДОСЬЕ. Вызывается на первом же входящем в любом канале, до
 * всякой карточки клиента и независимо от того, станет ли человек лидом.
 *
 * Возвращает null, если досье завести не на чем (нет ни одного подтверждённого
 * каналом идентификатора) или если запись упала. Отказ НЕ должен мешать ответу
 * клиенту: досье — это память, а не условие разговора.
 */
export async function resolveContactProfile(
  input: ResolveContactProfileInput
): Promise<ResolvedContactProfile | null> {
  const identities = normalizeIdentities(input.identities ?? []);
  const transport = identities.filter((i) => i.trust === "TRANSPORT");
  if (transport.length === 0) return null;

  try {
    const found = await findByTransport(transport);
    if (found) {
      await attachIdentities(found, identities);
      await applyName(found, input.name, input.nameSource);
      return { profileId: found, created: false };
    }

    const createdId = await createProfile(transport, input);
    if (createdId) {
      await attachIdentities(createdId, identities);
      return { profileId: createdId, created: true };
    }

    // Гонка: пока мы создавали, параллельное входящее уже завело досье по тому
    // же идентификатору и наша вставка упала на уникальном индексе. Второй
    // поиск обязан его найти — именно для этого индекс и стоит.
    const retried = await findByTransport(transport);
    if (!retried) return null;
    await attachIdentities(retried, identities);
    await applyName(retried, input.name, input.nameSource);
    return { profileId: retried, created: false };
  } catch (err) {
    void logSystemError("contact-profile", `не удалось завести досье: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-resolve",
    });
    return null;
  }
}

/** Поиск живого досье по подтверждённым каналом идентификаторам. */
async function findByTransport(transport: NormalizedIdentity[]): Promise<string | null> {
  const rows = await prisma.contactIdentity.findMany({
    /**
     * `trust: "TRANSPORT"` В УСЛОВИИ ОБЯЗАТЕЛЕН (правка 22.09.2026).
     *
     * Искали по паре «вид + значение», не глядя на доверие. Сегодня это молчит —
     * STATED-идентичностей пока никто не создаёт, — но в день, когда напечатанный
     * в чате номер начнут записывать, продиктованный продавцом номер жены молча
     * вернул бы досье мужа. Это ровно то автослияние, ради запрета которого
     * модуль и написан отдельным файлом: STATED идёт в предложение
     * администратору, а не в связку.
     */
    where: { trust: "TRANSPORT", OR: transport.map((i) => ({ kind: i.kind, value: i.value })) },
    select: { profileId: true, firstSeenAt: true },
    orderBy: { firstSeenAt: "asc" },
  });
  if (rows.length === 0) return null;

  const survivors: string[] = [];
  for (const row of rows) {
    const survivor = await resolveMergedInto(row.profileId);
    if (!survivors.includes(survivor)) survivors.push(survivor);
  }
  const chosen = survivors[0]!;
  // Два РАЗНЫХ живых досье по подтверждённым признакам одного касания — это
  // расхождение в данных, а не повод слить их молча: берём самое раннее и
  // оставляем человеку предложение связать.
  for (const other of survivors.slice(1)) {
    await proposeContactLink({ leftId: chosen, rightId: other, reason: "TRANSPORT_SPLIT" });
  }
  return chosen;
}

/** Создать досье вместе с подтверждёнными идентификаторами, одной транзакцией. */
async function createProfile(
  transport: NormalizedIdentity[],
  input: ResolveContactProfileInput
): Promise<string | null> {
  // Имя из профиля канала кладём в досье, но помечаем источник: обращаться им
  // бот не станет (в Instagram профиль зовётся «royal_dream_777»).
  const displayName = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
  try {
    const profile = await prisma.$transaction(async (tx) => {
      const created = await tx.contactProfile.create({
        data: {
          displayName,
          nameSource: displayName ? (input.nameSource ?? "profile") : null,
          facts: emptyContactFacts() as object,
        },
        select: { id: true },
      });
      await tx.contactIdentity.createMany({
        data: transport.map((i) => ({
          profileId: created.id,
          kind: i.kind,
          value: i.value,
          trust: i.trust,
        })),
      });
      return created;
    });
    return profile.id;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
}

/**
 * Дописать идентификаторы к досье. Ненадёжные (`STATED`, `PROFILE`), уже
 * занятые ДРУГИМ досье, не переносятся — они становятся предложением связать.
 */
async function attachIdentities(profileId: string, identities: NormalizedIdentity[]): Promise<void> {
  const now = new Date();
  for (const item of identities) {
    const existing = await prisma.contactIdentity.findUnique({
      where: { kind_value: { kind: item.kind, value: item.value } },
      select: { id: true, profileId: true },
    });
    if (existing) {
      const survivor = await resolveMergedInto(existing.profileId);
      if (survivor === profileId) {
        await prisma.contactIdentity.update({
          where: { id: existing.id },
          data: { lastSeenAt: now },
        });
      } else if (item.trust === "TRANSPORT") {
        // Подтверждённый каналом признак, принадлежащий другому досье, —
        // сильное основание, но всё равно не автослияние: сливает человек.
        await proposeContactLink({
          leftId: profileId,
          rightId: survivor,
          reason: "TRANSPORT_CONFLICT",
          evidence: { kind: item.kind },
        });
      } else {
        await proposeContactLink({
          leftId: profileId,
          rightId: survivor,
          reason: item.kind === "PHONE" ? "STATED_PHONE" : "STATED_IDENTITY",
          evidence: { kind: item.kind },
        });
      }
      continue;
    }
    try {
      await prisma.contactIdentity.create({
        data: { profileId, kind: item.kind, value: item.value, trust: item.trust },
      });
    } catch (err) {
      // P2002 — тот же идентификатор завели параллельно: это норма.
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
}

/** Имя: заполняем только пустое, и никогда не затираем названное самим человеком. */
async function applyName(
  profileId: string,
  name: string | null | undefined,
  source: ContactNameSource | undefined
): Promise<void> {
  const incomingSource = source ?? "profile";
  // Имя «самого человека» печатается в промт сырым — чистим при записи (02.10.2026,
  // lib/spokenName.ts): фраза вместо имени не должна стать частью промта навсегда.
  const clean = (incomingSource === "self" ? sanitizeSpokenName(name) : typeof name === "string" ? name.trim() : "") ?? "";
  if (!clean) return;
  const row = await prisma.contactProfile.findUnique({
    where: { id: profileId },
    select: { displayName: true, nameSource: true },
  });
  if (!row) return;
  const incoming = source ?? "profile";
  /**
   * Порядок доверия к имени: названное самим человеком > карточка CRM > профиль
   * канала. `crm` добавлен 22.09.2026 — ФИО из карточки не должно затираться
   * ником из профиля, но и не должно перебивать имя, которым человек
   * представился сам.
   */
  const strong = row.displayName && (row.nameSource === "self" || row.nameSource === "vcard");
  if (strong && incoming !== "self" && incoming !== "vcard") return;
  if (row.displayName && row.nameSource === "crm" && incoming === "profile") return;
  if (row.displayName === clean && row.nameSource === incoming) return;
  await prisma.contactProfile.update({
    where: { id: profileId },
    data: { displayName: clean, nameSource: incoming },
  });
}

/**
 * ИМЯ, НАЗВАННОЕ САМИМ ЧЕЛОВЕКОМ. Отдельная точка входа, потому что имя из
 * переписки узнаётся позже идентификаторов — на том ходе, где человек его
 * написал, а не при заведении досье. Имя из профиля канала сюда не передавать:
 * обращаться им запрещено решением владельца 18.08.2026 (клиент увидел в ответе
 * бота своё ФИО из профиля WhatsApp, хотя сам его не называл).
 */
export async function setContactSelfName(profileId: string, name: string | null | undefined): Promise<void> {
  try {
    await applyName(profileId, name, "self");
  } catch (err) {
    void logSystemError("contact-profile", `не удалось записать имя: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-name",
    });
  }
}

/** Ключ факта «Прочее», куда ложится имя, названное по телефону, когда у досье
 *  уже есть другое имя. Экран показывает ключ области misc как есть. */
export const CALL_NAME_FACT_KEY = "Имя по телефону";

/**
 * ИМЯ, НАЗВАННОЕ В ТЕЛЕФОННОМ ЗВОНКЕ (02.10.2026, защита от подменного номера).
 *
 * Звонящего досье узнаёт только по номеру, а номер в звонке подделывается.
 * Раньше консультант писал названное имя как «назвал сам» — то есть сильнее
 * всего прочего: позвонивший с чужого номера переименовывал в досье настоящего
 * владельца, и бот в WhatsApp здоровался с ним чужим именем. Поэтому по
 * телефону имя ЗАПИСЫВАЕТСЯ, только если в досье имени ещё нет (или оно то же
 * самое — тогда оно лишь становится «назвал сам»). Другое имя не затирает
 * прежнее, а ложится фактом в «Прочее» — агент увидит расхождение и разберётся.
 * Не бросает: досье — память, а не разговор.
 */
export async function setContactNameFromCall(profileId: string, name: string | null | undefined): Promise<void> {
  const clean = sanitizeSpokenName(name) ?? "";
  if (!clean) return;
  try {
    const row = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { displayName: true } });
    if (!row) return;
    const current = row.displayName?.trim() ?? "";
    if (!current || current.toLocaleLowerCase("ru") === clean.toLocaleLowerCase("ru")) {
      await applyName(profileId, current || clean, "self");
      return;
    }
    await recordContactFacts({ profileId, domain: "misc", values: { [CALL_NAME_FACT_KEY]: clean }, source: "model" });
  } catch (err) {
    void logSystemError("contact-profile", `не удалось записать имя из звонка: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-name",
    });
  }
}

export interface AttachContactProfileInput {
  /** Ссылка, которая уже стоит у диалога или звонка. null — ещё не заводили. */
  existingProfileId: string | null;
  identities: ContactIdentityInput[];
  name?: string | null;
  nameSource?: ContactNameSource;
  /** Записать ссылку в свою таблицу. Зовётся только когда ссылки ещё не было. */
  link: (profileId: string) => Promise<void>;
}

/**
 * ПОДКЛЮЧЕНИЕ ДОСЬЕ К ДИАЛОГУ ИЛИ ЗВОНКУ — единственная точка для всех каналов.
 *
 * Почему одна функция на все входы, а не по копии в каждом: у этого репозитория
 * есть свой известный класс поломок — «защита подключена не во всех каналах».
 * Четыре копии этой логики разошлись бы в первый же месяц, и разошлись бы молча:
 * ни один тест не падает от того, что в Telegram Direct досье не заводится.
 *
 * Отказ здесь НИКОГДА не должен ронять ход: досье — это память, а не условие
 * разговора. Поэтому функция возвращает null, а не бросает.
 */
export async function attachContactProfile(
  input: AttachContactProfileInput
): Promise<string | null> {
  try {
    if (input.existingProfileId) {
      const survivor = await resolveMergedInto(input.existingProfileId);
      const identities = normalizeIdentities(input.identities ?? []);
      if (identities.length > 0) await attachIdentities(survivor, identities);
      await applyName(survivor, input.name, input.nameSource);
      return survivor;
    }
    const resolved = await resolveContactProfile({
      identities: input.identities,
      name: input.name,
      nameSource: input.nameSource,
    });
    if (!resolved) return null;
    await input.link(resolved.profileId);
    return resolved.profileId;
  } catch (err) {
    void logSystemError(
      "contact-profile",
      `не удалось подключить досье: ${(err as Error).message}`,
      { stack: (err as Error).stack, dedupKey: "contact-profile-attach" }
    );
    return null;
  }
}

/**
 * КАКИЕ ПРИЗНАКИ ДАЁТ КАНАЛ МЕССЕНДЖЕРА. Одно место на все четыре входа, чтобы
 * «починка в одном месте работала везде» (прямое требование владельца
 * 21.09.2026): раньше похожие разборы идентификатора лежали в каждом канале
 * своей копией, и подключённая не во всех каналах защита — известный класс
 * поломок этого репозитория.
 *
 * WhatsApp даёт СРАЗУ ДВА признака: wa_id и настоящий номер, выведенный из него.
 * Оба подтверждены каналом, поэтому звонок с того же номера и переписка в
 * WhatsApp сходятся в одно досье сами, без участия человека.
 */
export function identitiesForMessengerChannel(
  channel: string,
  subscriberId: string
): ContactIdentityInput[] {
  const out: ContactIdentityInput[] = [];
  if (channel === WHATSAPP_CHANNEL) {
    out.push({ kind: "WA_ID", value: subscriberId, trust: "TRANSPORT" });
    const phone = whatsAppPhoneFromSubscriberId(channel, subscriberId);
    if (phone) out.push({ kind: "PHONE", value: phone, trust: "TRANSPORT" });
    return out;
  }
  if (channel === "INSTAGRAM") return [{ kind: "IG_ID", value: subscriberId, trust: "TRANSPORT" }];
  if (channel === "FACEBOOK") return [{ kind: "FB_PSID", value: subscriberId, trust: "TRANSPORT" }];
  if (channel === "WEBSITE") return [{ kind: "WEB_SESSION", value: subscriberId, trust: "TRANSPORT" }];
  // YOUTUBE (24.09.2026, находка ночной проверки Б8): без личных сообщений вовсе,
  // но комментатор — тот же человек, и канал сам даёт устойчивый идентификатор
  // (authorChannelId у Data API v3, см. messengers/youtubeComments.ts) — им и
  // заводим досье, ровно тем же приёмом, что у остальных каналов.
  if (channel === "YOUTUBE") return [{ kind: "YT_CHANNEL_ID", value: subscriberId, trust: "TRANSPORT" }];
  // Неизвестный канал — молчим: лучше без досье, чем с досье, склеенным по
  // признаку, смысла которого мы не знаем.
  return [];
}

/**
 * ЧТЕНИЕ-ПРАВКА-ЗАПИСЬ ТРЁХ JSON-ПОЛЕЙ ДОСЬЕ — ПОД ЗАМКОМ СТРОКИ (правка 22.09.2026).
 *
 * `languageCounts`, `categoryHistory` и `facts` правятся одинаково: прочитать,
 * дополнить в памяти, записать поле ЦЕЛИКОМ. Один и тот же человек пишет в двух
 * каналах одновременно — а это и есть суть досье, оно для того и заведено, —
 * два хода читают один снимок, и выигрывает тот, кто записал последним. Факты из
 * второго канала пропадают молча: в журнале оба `update` успешны.
 *
 * `SELECT ... FOR UPDATE` внутри транзакции: второй ход ждёт на строке, читает
 * уже дописанное и дополняет его. Замок держится микросекунды — между чтением и
 * записью здесь нет ни одного внешнего вызова.
 *
 * Строки нет (досье удалили между вызовами) — возвращаем `null`, зовущий тихо
 * выходит: досье это память, а не условие разговора.
 */
async function withProfileLock<T>(
  profileId: string,
  work: (tx: TxClient) => Promise<T>
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ContactProfile" WHERE "id" = ${profileId} FOR UPDATE`;
    if (locked.length === 0) return null;
    return work(tx);
  });
}

export interface RecordContactTurnInput {
  profileId: string;
  /** Язык входящего, как его определил `ai/clientLanguage.ts`. */
  language?: string | null;
  /** Диалог, в котором это случилось, — чтобы можно было пойти и перечитать. */
  conversationId?: string | null;
}

/**
 * ОТМЕТИТЬ ВХОДЯЩЕЕ. Считает касания и язык — то, что даёт «вернувшегося
 * человека» и «на каком языке с ним говорить» без чтения переписок.
 *
 * Язык решается по БОЛЬШИНСТВУ входящих, а не по последнему сообщению: одно
 * «salom» не делает переписку таджикской, а при равенстве счётчиков язык
 * остаётся пустым — обратиться не на том языке хуже, чем ответить на языке
 * последнего сообщения.
 */
export async function recordContactTurn(input: RecordContactTurnInput): Promise<void> {
  try {
    await withProfileLock(input.profileId, async (tx) => {
      const row = await tx.contactProfile.findUnique({
        where: { id: input.profileId },
        select: { languageCounts: true },
      });
      if (!row) return;
      const counts = parseContactLanguageCounts(row.languageCounts);
      const lang = input.language && input.language !== "unknown" ? input.language : null;
      if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
      await tx.contactProfile.update({
        where: { id: input.profileId },
        data: {
          lastSeenAt: new Date(),
          messagesIn: { increment: 1 },
          languageCounts: counts,
          ...(lang ? { language: dominantLanguage(counts) } : {}),
        },
      });
    });
  } catch (err) {
    void logSystemError("contact-profile", `не удалось отметить касание: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-turn",
    });
  }
}

export interface SetContactCategoryInput {
  profileId: string;
  category: ContactCategory;
  source: "model" | "guard" | "agent";
  conversationId?: string | null;
}

/**
 * Сменить категорию. Прошлое НЕ стирается (прямое требование владельца): человек
 * может сегодня продавать, а через месяц покупать, и обе роли настоящие —
 * поэтому смена дописывается в историю, а факты прежней области остаются лежать.
 *
 * `UNKNOWN` поверх известной категории не ставится: «в этом ходе не понял» — не
 * то же самое, что «человек снова незнакомец».
 */
export async function setContactCategory(input: SetContactCategoryInput): Promise<void> {
  if (!isContactCategory(input.category)) return;
  try {
    await withProfileLock(input.profileId, async (tx) => {
      const row = await tx.contactProfile.findUnique({
        where: { id: input.profileId },
        select: { category: true, categoryHistory: true },
      });
      if (!row) return;
      if (row.category === input.category) return;
      if (input.category === "UNKNOWN" && row.category !== "UNKNOWN") return;
      const history = parseContactCategoryHistory(row.categoryHistory);
      history.push({
        category: input.category,
        at: new Date().toISOString(),
        source: input.source,
        ...(input.conversationId ? { conv: input.conversationId } : {}),
      });
      await tx.contactProfile.update({
        where: { id: input.profileId },
        data: {
          category: input.category,
          categorySetAt: new Date(),
          // История не растёт бесконечно: держим последние 50 смен — по ним видно
          // и нынешнюю роль, и то, кем человек был раньше.
          categoryHistory: history.slice(-50),
        },
      });
    });
  } catch (err) {
    void logSystemError("contact-profile", `не удалось сменить категорию: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-category",
    });
  }
}

/**
 * КАТЕГОРИЯ ДОСЬЕ ДЛЯ РЕШЕНИЯ О ТИПЕ КАРТОЧКИ (§10.4 плана, 22.09.2026).
 *
 * Единственное место, которое читает тумблер `Settings.contactCategoryDrivesLeadKind`
 * — вызывающий код (`intakePolicy.classifyInbound`) сам ничего не решает, только
 * передаёт то, что вернула эта функция. Выключенный тумблер — `null` всегда,
 * даже если у человека есть установленная категория: `ai/leadKind.ts` не должен
 * получать её, чтобы «выключено — побайтово как раньше» было гарантией кода, а
 * не соглашением между двумя модулями.
 *
 * `UNKNOWN` категорией не считается: досье без единого установленного признака
 * не должно подсказывать ничего, иначе КАЖДЫЙ неуверенный ход нового собеседника
 * ловил бы собственную пустоту.
 */
export async function categoryForLeadKind(profileId: string | null | undefined): Promise<string | undefined> {
  if (!profileId) return undefined;
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { contactCategoryDrivesLeadKind: true },
    });
    if (!settings?.contactCategoryDrivesLeadKind) return undefined;
    const profile = await prisma.contactProfile.findUnique({
      where: { id: profileId },
      select: { category: true },
    });
    return profile && profile.category !== "UNKNOWN" ? profile.category : undefined;
  } catch (err) {
    void logSystemError("contact-profile", `не удалось прочитать категорию для типа карточки: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-category-for-lead-kind",
    });
    return undefined;
  }
}

export interface RecordContactFactsInput {
  profileId: string;
  domain: ContactFactDomain;
  /** {ключ: значение} — только то, что узнали в этом ходе. */
  values: Record<string, string | number | boolean | null | undefined>;
  source: "model" | "guard" | "agent";
  conversationId?: string | null;
}

/**
 * Записать факты о человеке. Каждый факт хранится вместе с происхождением и
 * временем: без этого досье через месяц превращается в свалку утверждений,
 * которую нельзя ни проверить, ни состарить.
 *
 * Факт от человека (`agent`) не перебивается догадкой модели — иначе один
 * неудачный ход бота затирал бы то, что агент выяснил голосом.
 */
export async function recordContactFacts(input: RecordContactFactsInput): Promise<void> {
  try {
    await withProfileLock(input.profileId, async (tx) => {
      const row = await tx.contactProfile.findUnique({
        where: { id: input.profileId },
        select: { facts: true },
      });
      if (!row) return;
      const { facts, recognized } = readContactFacts(row.facts);
      /**
       * НЕПОНЯТОЕ ДОСЬЕ НЕ ЗАТИРАЕТСЯ (правка 22.09.2026).
       *
       * Поле пишется ЦЕЛИКОМ, а чтение при неудаче разбора отдаёт пустую
       * структуру — то есть поднятая `version` или одна кривая запись означали
       * бы, что первое же сообщение каждого человека стирает накопленное за
       * месяцы, молча и безвозвратно. Лучше не записать новый факт (он придёт
       * снова со следующим ходом), чем потерять все старые.
       */
      if (!recognized) {
        void logSystemError(
          "contact-profile",
          `Досье ${input.profileId}: факты в непонятном формате — запись пропущена, чтобы не затереть накопленное. Разобрать руками.`,
          { dedupKey: "contact-profile-facts-unreadable" }
        );
        return;
      }
      const domain = facts[input.domain];
      let changed = false;
      for (const [key, value] of Object.entries(input.values)) {
        if (value === null || value === undefined || value === "") continue;
        const prev: ContactFact | undefined = domain[key];
        if (prev && prev.src === "agent" && input.source !== "agent") continue;
        if (prev && prev.v === value && prev.src === input.source) continue;
        domain[key] = {
          v: value,
          at: new Date().toISOString(),
          src: input.source,
          ...(input.conversationId ? { conv: input.conversationId } : {}),
        };
        changed = true;
      }
      if (!changed) return;
      await tx.contactProfile.update({
        where: { id: input.profileId },
        data: { facts: facts as object },
      });
    });
  } catch (err) {
    void logSystemError("contact-profile", `не удалось записать факты: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-facts",
    });
  }
}

export interface ProposeContactLinkInput {
  leftId: string;
  rightId: string;
  reason: string;
  evidence?: Record<string, unknown>;
}

/**
 * «Похоже, это тот же человек» — предложение, которое подтверждает человек.
 *
 * Пара хранится УПОРЯДОЧЕННОЙ (меньший id слева), иначе одно и то же
 * предложение заводилось бы дважды — с двух сторон — и разбор превратился бы в
 * отписку. Отклонённое предложение заново не заводится по той же причине.
 */
export async function proposeContactLink(input: ProposeContactLinkInput): Promise<void> {
  if (!input.leftId || !input.rightId || input.leftId === input.rightId) return;
  const [leftId, rightId] =
    input.leftId < input.rightId ? [input.leftId, input.rightId] : [input.rightId, input.leftId];
  try {
    const existing = await prisma.contactLinkCandidate.findUnique({
      where: { leftId_rightId: { leftId, rightId } },
      select: { id: true },
    });
    if (existing) return;
    await prisma.contactLinkCandidate.create({
      data: { leftId, rightId, reason: input.reason, evidence: (input.evidence ?? {}) as object },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return;
    void logSystemError(
      "contact-profile",
      `не удалось предложить связку досье: ${(err as Error).message}`,
      { stack: (err as Error).stack, dedupKey: "contact-profile-link" }
    );
  }
}

export interface MergeContactProfilesInput {
  /** Досье, которое остаётся жить. */
  targetId: string;
  /** Досье, которое сливаем (запись остаётся с пометкой mergedIntoId). */
  sourceId: string;
  reason: string;
  /** Кто слил — сотрудник; пусто для автоматики. */
  byId?: string | null;
}

/** Две истории смен категории → одна: по времени, без дублей, последние 50. */
function mergeCategoryHistories(
  a: ContactCategoryHistoryEntry[],
  b: ContactCategoryHistoryEntry[]
): ContactCategoryHistoryEntry[] {
  const seen = new Set<string>();
  const out: ContactCategoryHistoryEntry[] = [];
  for (const entry of [...a, ...b]) {
    const key = `${entry.category}|${entry.at}|${entry.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return out.slice(-50);
}

/**
 * СЛИТЬ ДВА ДОСЬЕ. Вызывается подтверждением человека, а не автоматикой.
 *
 * Слитая запись НЕ удаляется, а помечается ссылкой на выжившую: ссылки диалогов
 * на неё остаются рабочими, а ошибочное слияние можно разобрать — удаление было
 * бы необратимо. Всё одной транзакцией: половина перенесённых идентификаторов
 * при упавшем переносе диалогов — это ровно то смешение двух людей, ради
 * предотвращения которого весь модуль и написан.
 */
export async function mergeContactProfilesInTransaction(tx: TxClient, input: MergeContactProfilesInput): Promise<void> {
  if (input.targetId === input.sourceId) throw new Error("нельзя слить досье с самим собой");
      const [target, source] = await Promise.all([
        tx.contactProfile.findUnique({ where: { id: input.targetId } }),
        tx.contactProfile.findUnique({ where: { id: input.sourceId } }),
      ]);
      if (!target || !source) throw new Error("одно из досье не найдено");

      /**
       * НАДГРОБИЕ НЕ СЛИВАЕТСЯ ПОВТОРНО (правка 22.09.2026).
       *
       * У досье с проставленным `mergedIntoId` идентификаторы и переписки уже
       * уехали к выжившему, а сама запись живёт только ради разбора ошибки.
       * Слить её второй раз значило бы переписать эту ссылку и получить кольцо
       * A→B→A: у обеих записей стоит «я слита в другую», живой нет ни одной, и
       * `resolveContactProfile` ходит по кругу. Кандидаты на такие записи
       * гаснут ниже, но пара могла быть создана раньше слияния или прийти извне.
       */
      if (source.mergedIntoId || target.mergedIntoId) {
        throw new Error("досье уже слито с другим — сливать надгробие нельзя");
      }

      // Идентификаторы: уникальность пары (kind, value) не даёт перенести
      // занятые — такие просто остаются на слитой записи, и это честно: они уже
      // указывают на того же человека через выжившее досье.
      const sourceIdentities = await tx.contactIdentity.findMany({
        where: { profileId: source.id },
        select: { id: true, kind: true, value: true },
      });
      for (const identity of sourceIdentities) {
        const taken = await tx.contactIdentity.findUnique({
          where: { kind_value: { kind: identity.kind, value: identity.value } },
          select: { profileId: true },
        });
        if (taken && taken.profileId !== source.id) continue;
        await tx.contactIdentity.update({
          where: { id: identity.id },
          data: { profileId: target.id },
        });
      }

      await Promise.all([
        tx.botConversation.updateMany({
          where: { contactProfileId: source.id },
          data: { contactProfileId: target.id },
        }),
        tx.telegramConversation.updateMany({
          where: { contactProfileId: source.id },
          data: { contactProfileId: target.id },
        }),
        tx.telegramDirectConversation.updateMany({
          where: { contactProfileId: source.id },
          data: { contactProfileId: target.id },
        }),
        tx.incomingCall.updateMany({
          where: { contactProfileId: source.id },
          data: { contactProfileId: target.id },
        }),
        // Анкеты кандидата — такой же спутник досье, как переписки: оставить их на
        // слитом досье значит потерять рассказ человека о себе ровно тогда, когда
        // администратор наконец признал, что это один и тот же человек.
        tx.jobApplication.updateMany({
          where: { contactProfileId: source.id },
          data: { contactProfileId: target.id },
        }),
      ]);

      // Факты: чего у выжившего нет — забираем; спорное оставляем выжившему.
      const targetFacts = parseContactFacts(target.facts);
      const sourceFacts = parseContactFacts(source.facts);
      for (const domain of ["buyer", "seller", "job", "misc"] as ContactFactDomain[]) {
        for (const [key, fact] of Object.entries(sourceFacts[domain])) {
          if (!targetFacts[domain][key]) targetFacts[domain][key] = fact;
        }
      }

      /**
       * ИСТОРИЯ РОЛЕЙ ЕДЕТ ВМЕСТЕ С ДОСЬЕ (CONTACT01, аудит 04.10.2026).
       *
       * Читатели (карточка, промт бота) берут «кем человек был раньше» у выжившего,
       * а источник становится надгробием. Раньше история оставалась только в нём, и
       * покупавший, а теперь продающий человек терял прежнюю роль. Склеиваем по
       * времени, без дублей (категория+время+источник), держим последние 50, как
       * setContactCategory. Дата смены согласуется с выбранной категорией: если
       * берём категорию источника, то и его дату.
       */
      const mergedHistory = mergeCategoryHistories(
        parseContactCategoryHistory(target.categoryHistory),
        parseContactCategoryHistory(source.categoryHistory)
      );
      const takesSourceCategory = target.category === "UNKNOWN";

      const counts = parseContactLanguageCounts(target.languageCounts);
      for (const [lang, n] of Object.entries(parseContactLanguageCounts(source.languageCounts))) {
        counts[lang] = (counts[lang] ?? 0) + n;
      }

      await tx.contactProfile.update({
        where: { id: target.id },
        data: {
          facts: targetFacts as object,
          languageCounts: counts,
          language: dominantLanguage(counts),
          displayName: target.displayName ?? source.displayName,
          nameSource: target.displayName ? target.nameSource : source.nameSource,
          clientId: target.clientId ?? source.clientId,
          messagesIn: target.messagesIn + source.messagesIn,
          firstSeenAt: source.firstSeenAt < target.firstSeenAt ? source.firstSeenAt : target.firstSeenAt,
          lastSeenAt: source.lastSeenAt > target.lastSeenAt ? source.lastSeenAt : target.lastSeenAt,
          category: takesSourceCategory ? source.category : target.category,
          categoryHistory: mergedHistory,
          categorySetAt: takesSourceCategory ? (source.categorySetAt ?? target.categorySetAt) : target.categorySetAt,
        },
      });

      await tx.contactProfile.update({
        where: { id: source.id },
        data: { mergedIntoId: target.id, clientId: null },
      });

      await tx.contactProfileMerge.create({
        data: {
          targetId: target.id,
          sourceId: source.id,
          reason: input.reason,
          mergedById: input.byId ?? null,
          snapshot: {
            displayName: source.displayName,
            category: source.category,
            messagesIn: source.messagesIn,
            facts: sourceFacts,
            categoryHistory: parseContactCategoryHistory(source.categoryHistory),
            categorySetAt: source.categorySetAt?.toISOString() ?? null,
          } as object,
        },
      });

      await tx.contactLinkCandidate.updateMany({
        where: {
          OR: [
            { leftId: source.id, rightId: target.id },
            { leftId: target.id, rightId: source.id },
          ],
        },
        data: { status: "ACCEPTED", decidedAt: new Date(), decidedById: input.byId ?? null },
      });

      /**
       * ОСТАЛЬНЫЕ КАНДИДАТЫ СЛИТОГО ДОСЬЕ ТОЖЕ ГАСНУТ (правка 22.09.2026).
       *
       * Гасла только своя пара, а прочие предложения с участием слитой записи
       * оставались в очереди и показывали администратору надгробие: у неё уже
       * проставлен `mergedIntoId`, а идентификаторы и переписки уехали к
       * выжившему. Подтверждение такого кандидата перезаписывало `mergedIntoId`
       * во ВТОРОЕ досье, и человек получал две живые записи, каждую с половиной
       * правды, — разобрать это обратно нечем.
       *
       * Классический «спутник не гаснет при смерти родителя»: слияние обязано
       * убирать за собой всё, что на слитую запись ссылалось.
       */
      await tx.contactLinkCandidate.updateMany({
        where: {
          status: { in: ["PENDING", "IN_PROGRESS"] },
          OR: [{ leftId: source.id }, { rightId: source.id }],
        },
        data: { status: "OBSOLETE", decidedAt: new Date(), decidedById: input.byId ?? null },
      });
}

export async function mergeContactProfiles(input: MergeContactProfilesInput): Promise<boolean> {
  if (input.targetId === input.sourceId) return false;
  try {
    await prisma.$transaction((tx) => mergeContactProfilesInTransaction(tx, input));
    return true;
  } catch (err) {
    void logSystemError("contact-profile", `не удалось слить досье: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-merge",
    });
    return false;
  }
}

/**
 * Связать досье с карточкой клиента, когда она наконец появилась.
 *
 * Анкеты кандидата переклеиваются тем же действием и в той же транзакции: экран
 * руководства сводит анкету с карточкой по `JobApplication.clientId`, и оставить
 * её без клиента значило бы показать двух разных людей вместо одного.
 */
export async function linkContactProfileToClient(profileId: string, clientId: string): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.contactProfile.update({
        where: { id: profileId },
        data: { clientId },
      }),
      prisma.jobApplication.updateMany({
        where: { contactProfileId: profileId },
        data: { clientId },
      }),
    ]);
  } catch (err) {
    void logSystemError(
      "contact-profile",
      `не удалось связать досье с клиентом: ${(err as Error).message}`,
      { stack: (err as Error).stack, dedupKey: "contact-profile-client" }
    );
  }
}

/** Короткая подпись досье для журналов и экрана «Чаты». */
export function contactProfileSummary(profile: {
  displayName: string | null;
  category: string;
  messagesIn: number;
}): string {
  const name = profile.displayName ?? "без имени";
  return `${name} · ${contactCategoryLabel(profile.category)} · сообщений: ${profile.messagesIn}`;
}
