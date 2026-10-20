import { prisma } from "../db.js";
import { decryptSecretSafe, encryptSecret } from "../crypto.js";
import {
  describeError,
  instagramTokenIdentity,
  instagramTokenSeesUser,
  loadCredentials,
  resetMetaAccountCredsCache,
} from "./meta.js";
import { logSystemError } from "../lib/systemError.js";
import { readInstalledCustomerTransport } from "../lib/customerInstalledTransport.js";

/**
 * Подключённые аккаунты мессенджеров: какой Instagram (WhatsApp, Facebook) чей.
 *
 * ЗАЧЕМ. До 15.08.2026 CRM держала ровно ОДИН аккаунт на канал: маркер лежал
 * одиночным полем в Settings, входящее разбиралось без учёта получателя, ответ
 * всегда уходил этим единственным маркером. Второй Instagram (Royal Home Info —
 * советы, чек-листы, вакансии) подключить было некуда: он писал бы в те же
 * диалоги, а отвечала бы CRM от имени основного аккаунта.
 *
 * КАК УСТРОЕНО. Аккаунт находится по паре (канал, externalId), где externalId —
 * то, чем Meta помечает получателя во входящем: `entry[].id` для Instagram и
 * Messenger, `phone_number_id` для WhatsApp. Найденный аккаунт запоминается в
 * диалоге, и ответ уходит ЕГО маркером — даже если человек написал неделю назад.
 *
 * СТАРЫЕ НАСТРОЙКИ ПРОДОЛЖАЮТ РАБОТАТЬ. Пока в таблице нет ни одного аккаунта
 * канала, используется маркер из Settings — ровно прежнее поведение. Это
 * сознательно: выкат, который требует «сначала заведите аккаунты, иначе
 * переписка встанет», ломает работу агентства в момент установки.
 */

export interface MessengerAccountView {
  id: string;
  channel: string;
  externalId: string;
  title: string;
  enabled: boolean;
  isDefault: boolean;
  /** Маркер наружу не отдаём — только признак, что он задан. */
  hasToken: boolean;
  /** Свой секрет приложения задан (аккаунт живёт в отдельном приложении Meta). */
  hasAppSecret: boolean;
  /** Своя «личность» бота у этого аккаунта. Пусто — работает общая из Настроек. */
  systemPrompt: string | null;
  /** Идентификаторы, добавленные вручную — Meta их своим ответом не подтверждает
   *  и подтвердить не может (см. schema.prisma, поле extraExternalIds). */
  extraExternalIds: string[];
}

export interface ResolvedAccount {
  /** null — аккаунтов в таблице нет, работаем на старых настройках. */
  id: string | null;
  title: string;
  token: string | undefined;
  /**
   * Аккаунт узнан по получателю из вебхука (или он у канала единственный), а не
   * взят «по умолчанию» среди нескольких (02.10.2026).
   *
   * Догадка годится, чтобы ответить, но не годится, чтобы ПЕРЕПИСАТЬ аккаунт уже
   * привязанной переписки: одно входящее с незнакомым получателем раньше молча
   * перекидывало диалог Royal Home Info в Royal Home, и он пропадал из фильтра
   * своего аккаунта (см. upsertConversation в messengers/conversation.ts).
   */
  certain?: boolean;
}

/**
 * Кэш на минуту: маршрут вебхука дёргает это на каждое сообщение, а состав
 * аккаунтов меняется раз в месяц. Сбрасывается при любой правке (см. ниже) —
 * иначе только что подключённый аккаунт молчал бы до конца минуты.
 */
const CACHE_MS = 60_000;
let cache: {
  at: number;
  rows: Array<{
    id: string;
    channel: string;
    externalId: string;
    title: string;
    token: string;
    enabled: boolean;
    isDefault: boolean;
    systemPrompt: string | null;
    username: string | null;
    messagingId: string | null;
    /** Идентификаторы, введённые вручную (см. schema.prisma) — Meta их не подтверждает. */
    extraExternalIds: string[];
  }>;
} | null = null;
/** Когда последний раз сверяли идентификаторы с Meta — см. reconcileInstagramAccountIds. */
let lastReconcileAt = 0;

export function resetAccountsCache(): void {
  cache = null;
  // Транспорт Meta держит свой кэш тех же строк (ключи приложения и номера
  // WhatsApp, см. meta.ts): без сброса только что заведённый аккаунт минуту
  // получал бы 403 на вебхуке — подпись сверялась бы без его секрета.
  resetMetaAccountCredsCache();
  // Заодно снимаем задвижку сверки идентификаторов (reconcileInstagramAccountIds):
  // состав аккаунтов изменился — значит и сверять их можно заново, не выжидая
  // десять минут. Зацикливания не даёт: сверка меняет запись только когда Meta
  // вернула другой идентификатор, а после исправления она возвращает тот же самый.
  lastReconcileAt = 0;
}

async function loadAccounts() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await prisma.messengerAccount.findMany({ orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  cache = { at: Date.now(), rows };
  return rows;
}

/** Все аккаунты канала — для экрана настроек и переключателя в «Сообщениях». */
export async function listAccounts(channel?: string): Promise<MessengerAccountView[]> {
  const rows = await loadAccounts();
  return rows
    .filter((r) => !channel || r.channel === channel)
    .map((r) => ({
      id: r.id,
      channel: r.channel,
      externalId: r.externalId,
      title: r.title,
      enabled: r.enabled,
      isDefault: r.isDefault,
      hasToken: Boolean(decryptSecretSafe(r.token)),
      // Через приведение типа: колонка добавляется отдельной миграцией схемы.
      hasAppSecret: Boolean((r as { appSecret?: string | null }).appSecret),
      systemPrompt: r.systemPrompt,
      extraExternalIds: r.extraExternalIds,
    }));
}

/**
 * Своя «личность» бота у аккаунта — или null, если её нет и работает общая.
 *
 * Отдельной функцией, а не через listAccounts: промт нужен на КАЖДОМ ходе модели,
 * и звать сюда за одним полем дешевле, чем собирать список с расшифровкой маркеров.
 * Отказ базы — тоже null: разговор с общей «личностью» лучше, чем упавший ход.
 */
export async function accountPersona(accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null;
  try {
    const row = (await loadAccounts()).find((r) => r.id === accountId);
    return row?.systemPrompt?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Чьим маркером отвечать на входящее.
 *
 * @param externalId получатель из вебхука; пусто — берём аккаунт по умолчанию.
 * @param senderId кто написал — по нему незнакомый получатель Instagram
 *   узнаётся сам (learnRecipientBySender). Без него — прежнее поведение.
 */
export async function resolveIncomingAccount(
  channel: string,
  externalId: string | undefined,
  senderId?: string
): Promise<ResolvedAccount> {
  let rows = (await loadAccounts()).filter((r) => r.channel === channel);

  // Аккаунтов не завели — прежнее поведение на настройках из Settings.
  if (!rows.length) return { id: null, title: "Основной", token: await legacyToken(channel) };

  // Сопоставляем по ОБОИМ идентификаторам Meta: в комментариях шлёт user_id, в
  // личных сообщениях — id того же аккаунта (см. meta.ts, разбор 17.08.2026). Плюс
  // extraExternalIds — идентификаторы, которые Meta ни разу не подтвердит сама
  // (см. schema.prisma, разбор 22.08.2026: получатель 873975375804470 не был ни
  // тем, ни другим, и reconcileInstagramAccountIds чинить было нечем).
  const matches = (r: { externalId: string; messagingId: string | null; extraExternalIds: string[] }, id: string) =>
    r.externalId === id || r.messagingId === id || r.extraExternalIds.includes(id);
  let exact = externalId ? rows.find((r) => matches(r, externalId)) : undefined;

  // Получатель незнаком — прежде чем отвечать чужим аккаунтом, спросим у Meta,
  // не устарели ли записанные идентификаторы (см. reconcileInstagramAccountIds).
  if (externalId && !exact && channel === "INSTAGRAM") {
    if (await reconcileInstagramAccountIds()) {
      rows = (await loadAccounts()).filter((r) => r.channel === channel);
      exact = rows.find((r) => matches(r, externalId));
    }
  }

  // Сверка не помогла — спросим Meta, чей маркер видит написавшего, и запомним
  // получателя за этим аккаунтом (02.10.2026, см. learnRecipientBySender).
  if (externalId && !exact && channel === "INSTAGRAM" && senderId && rows.length > 1) {
    const learnedId = await learnRecipientBySender(rows, externalId, senderId);
    if (learnedId) {
      rows = (await loadAccounts()).filter((r) => r.channel === channel);
      exact = rows.find((r) => r.id === learnedId);
    }
  }

  /**
   * ТУМБЛЕР «ВКЛЮЧЁН» ОБЯЗАН ВЫКЛЮЧАТЬ (30.08.2026).
   *
   * В ветке точного совпадения `enabled` не проверялся вовсе: выключенный в
   * интерфейсе аккаунт продолжал отвечать, и заглушить его владелец не мог
   * никак — тумблер двигался, а поведение не менялось.
   *
   * Отвечать вместо него аккаунтом по умолчанию НЕЛЬЗЯ: человек писал в один
   * аккаунт, ответ ушёл бы из другого — ровно та поломка, что стоила нам воронки
   * 17.08.2026. Поэтому оставляем сам аккаунт (диалог привяжется к нему верно), а
   * маркер не отдаём: отправлять нечем, и это и есть «выключено».
   *
   * В журнал — потому что снаружи молчание аккаунта неотличимо от поломки.
   */
  if (exact && !exact.enabled) {
    void logSystemError(
      "meta",
      `${channel}: аккаунт «${exact.title}» выключен в Настройках → Каналы — входящее записано, но ответа не будет. ` +
        `Если он должен работать, включите его тумблером.`
    );
    return { id: exact.id, title: exact.title, token: undefined, certain: true };
  }

  // A legacy Settings installation can coexist with unrelated installed DB
  // accounts. Only its exact configured WA/FB resource (with token) qualifies;
  // never turn an unknown recipient into a Settings/default-account grant.
  if (!exact && externalId && (channel === "WHATSAPP" || channel === "FACEBOOK") &&
      await readInstalledCustomerTransport(prisma, channel, externalId)) {
    return { id: null, title: "Основной", token: await legacyToken(channel), certain: true };
  }

  const chosen = exact ?? rows.find((r) => r.isDefault && r.enabled) ?? rows.find((r) => r.enabled) ?? rows[0];

  if (externalId && !exact) {
    /**
     * Пишут в аккаунт, которого мы не знаем: ответим основным — но это ОШИБКА, а
     * не заметка в консоли.
     *
     * До 17.08.2026 здесь стоял console.warn, и его не видел никто: журнал CRM
     * его не показывает, а в логи контейнера владелец не ходит. Ровно этим
     * маскировался живой случай — комментарий под видео одного аккаунта уводил
     * личное сообщение во второй, и со стороны это выглядело необъяснимо
     * («бот пишет не с того аккаунта»), потому что следа не оставалось нигде.
     *
     * Ошибку в журнал, не бросок: ответить чем-то лучше, чем промолчать, а
     * разобраться владелец сможет только увидев, что это вообще происходит.
     */
    void logSystemError(
      "meta",
      `${channel}: входящее для неизвестного получателя ${externalId} — отвечаю аккаунтом «${chosen.title}». ` +
        `Если аккаунтов несколько, ответ может уйти не тем, кому написал человек: проверьте Настройки → Каналы.`
    );
  }

  return {
    id: chosen.id,
    title: chosen.title,
    token: decryptSecretSafe(chosen.token) || undefined,
    certain: Boolean(exact) || rows.length === 1,
  };
}

/**
 * НЕЗНАКОМЫЙ ПОЛУЧАТЕЛЬ INSTAGRAM УЗНАЁТСЯ ПО НАПИСАВШЕМУ (02.10.2026).
 *
 * Жалоба владельца: в фильтре «Royal Home Info» последние переписки — от 21
 * сентября, хотя в этот аккаунт пишут каждый день. Входящее с получателем,
 * которого нет ни в одном аккаунте, уходило аккаунту по умолчанию: переписка
 * записывалась на Royal Home, бот отвечал не тем маркером, а в журнале копились
 * «неизвестный получатель». Сверка с Meta (reconcileInstagramAccountIds) такой
 * случай не лечит: Meta шлёт в личных сообщениях идентификатор, которого не
 * отдаёт ни одним запросом (разбор 22.08.2026, extraExternalIds), — и починить
 * его мог только владелец руками, вписав номер из текста ошибки.
 *
 * Но ответ, кому писал человек, у Meta есть: идентификатор собеседника выдан
 * паре «человек + наш аккаунт», и профиль по нему читается ТОЛЬКО маркером того
 * аккаунта, которому он писал (instagramTokenSeesUser). Ровно один «видит» —
 * получатель принадлежит ему, и мы записываем его в extraExternalIds, как сделал
 * бы владелец. Дальше такие письма находят аккаунт сразу, без запросов.
 *
 * Видят двое или никто, Meta не ответила — не гадаем: остаётся прежнее
 * поведение с ошибкой в журнале. Одного получателя пробуем не чаще раза в
 * десять минут: иначе каждое письмо при лежащей Meta стоило бы секунды.
 *
 * @returns id аккаунта, за которым запомнили получателя, или null.
 */
const LEARN_COOLDOWN_MS = 10 * 60_000;
const LEARN_CALL_TIMEOUT_MS = 3_000;
const learnTriedAt = new Map<string, number>();

/** Только для тестов: забыть, каких получателей уже пробовали. */
export function resetRecipientLearning(): void {
  learnTriedAt.clear();
}

async function learnRecipientBySender(
  rows: Array<{ id: string; title: string; token: string; enabled: boolean; extraExternalIds: string[] }>,
  externalId: string,
  senderId: string
): Promise<string | null> {
  const tried = learnTriedAt.get(externalId);
  if (tried !== undefined && Date.now() - tried < LEARN_COOLDOWN_MS) return null;
  learnTriedAt.set(externalId, Date.now());

  const candidates = rows
    .map((r) => ({ row: r, token: decryptSecretSafe(r.token) }))
    .filter((c): c is { row: (typeof rows)[number]; token: string } => Boolean(c.token));
  if (candidates.length < 2) return null;

  const answers = await Promise.all(
    candidates.map((c) => instagramTokenSeesUser(c.token, senderId, LEARN_CALL_TIMEOUT_MS))
  );
  // Хоть один «не знаю» — картина неполная: видящий мог оказаться среди
  // неответивших, и тогда «единственный видящий» был бы ложным.
  if (answers.some((a) => a === null)) return null;
  const seeing = candidates.filter((_, i) => answers[i] === true);
  if (seeing.length !== 1) return null;

  const owner = seeing[0].row;
  try {
    await prisma.messengerAccount.update({
      where: { id: owner.id },
      data: { extraExternalIds: Array.from(new Set([...owner.extraExternalIds, externalId])) },
    });
  } catch (err) {
    await logSystemError("meta", `Получатель ${externalId} не запомнен за аккаунтом «${owner.title}»: ${describeError(err)}`);
    return null;
  }
  resetAccountsCache();
  console.warn(`[аккаунты] INSTAGRAM «${owner.title}»: получатель ${externalId} узнан по написавшему и запомнен`);
  return owner.id;
}

/**
 * САМОПОЧИНКА ИДЕНТИФИКАТОРОВ Instagram: спрашиваем у маркера, чей он.
 *
 * ЗАЧЕМ. У аккаунта Instagram два идентификатора, и в вебхуке приходит `user_id`,
 * а не тот, что показывает панель Meta (подробно — в instagramTokenIdentity).
 * Аккаунты, заведённые до 15.08.2026, записаны вторым видом: ни одно входящее с
 * ними не совпадает, и переписка обоих аккаунтов молча отвечается основным. Одной
 * правки кода мало — записи в базе уже неверные, а маркер в интерфейсе наружу не
 * отдаётся, и «просто пересохранить аккаунт» владелец не может: маркера у него
 * перед глазами нет. Поэтому чиним данные сами.
 *
 * КОГДА. Только когда пришло входящее с незнакомым получателем — то есть ровно в
 * той ситуации, которую это и лечит. Не на старте: запуск не должен зависеть от
 * доступности Meta.
 *
 * ЧАСТОТА. Не чаще раза в 10 минут на весь процесс. Незнакомый получатель бывает и
 * законным (аккаунт отключили, но подписчик пишет) — без задвижки каждое такое
 * сообщение стучалось бы в Meta по разу на аккаунт и добавляло секунды к ответу.
 *
 * СРОК. Вызов сидит в обработке вебхука, а Meta ждёт от нас 200: затянем — получим
 * повторную доставку того же сообщения. Поэтому два ограничения сразу: свой
 * короткий срок на КАЖДЫЙ запрос к Meta и общий бюджет на всю сверку. Одного
 * бюджета мало — он лишь не даёт начать новый запрос, а уже начатый висел бы
 * общие 15 секунд, и на этом обработка одного сообщения занимала 10+ секунд.
 *
 * @returns true — что-то поменяли, состав аккаунтов стоит перечитать.
 */
const RECONCILE_COOLDOWN_MS = 10 * 60_000;
const RECONCILE_BUDGET_MS = 8_000;
/** Срок одного запроса к Meta при сверке — короче общего (см. instagramTokenIdentity). */
const RECONCILE_CALL_TIMEOUT_MS = 3_000;

export async function reconcileInstagramAccountIds(): Promise<boolean> {
  if (Date.now() - lastReconcileAt < RECONCILE_COOLDOWN_MS) return false;
  lastReconcileAt = Date.now();

  const deadline = Date.now() + RECONCILE_BUDGET_MS;
  const rows = (await loadAccounts()).filter((r) => r.channel === "INSTAGRAM");
  let changed = false;

  for (const row of rows) {
    if (Date.now() > deadline) break;
    const token = decryptSecretSafe(row.token);
    if (!token) continue;

    const identity = await instagramTokenIdentity(token, RECONCILE_CALL_TIMEOUT_MS);
    if (!identity.ok) {
      // Отказ Meta — не повод ронять ответ клиенту: оставляем как есть и пишем в журнал.
      await logSystemError(
        "meta",
        `Не удалось сверить идентификатор Instagram-аккаунта «${row.title}»: ${identity.error}`
      );
      continue;
    }
    /**
     * НИК ЗАПИСЫВАЕМ ВСЕГДА, даже когда идентификатор совпал.
     *
     * По нику мы узнаём самих себя во входящем (см. lib/ownAccountGuard.ts), и
     * взяться ему больше неоткуда: Meta отдаёт его тем же запросом, что и id.
     * Раньше выход стоял строкой ниже — на совпавшем идентификаторе функция
     * заканчивалась, и ник не заполнялся бы никогда.
     */
    /**
     * Ник и ВТОРОЙ идентификатор записываем всегда, даже когда основной совпал:
     * по нику мы узнаём самих себя во входящем, а по второму идентификатору —
     * находим аккаунт в личных сообщениях (Meta шлёт там другой, см. meta.ts).
     * Раньше выход стоял строкой ниже, на совпавшем идентификаторе, и оба поля
     * не заполнялись бы никогда.
     */
    const patch: { username?: string; messagingId?: string } = {};
    if (identity.username && identity.username !== row.username) patch.username = identity.username;
    if (identity.messagingId && identity.messagingId !== row.messagingId) patch.messagingId = identity.messagingId;
    if (Object.keys(patch).length > 0) {
      await prisma.messengerAccount
        .update({ where: { id: row.id }, data: patch })
        .then(() => {
          changed = true;
        })
        .catch((err) => logSystemError("meta", `Данные аккаунта «${row.title}» не записаны: ${describeError(err)}`));
    }

    if (identity.id === row.externalId) continue;

    try {
      await prisma.messengerAccount.update({
        where: { id: row.id },
        data: { externalId: identity.id },
      });
      changed = true;
      console.warn(
        `[аккаунты] INSTAGRAM «${row.title}»: идентификатор исправлен ${row.externalId} → ${identity.id} (по ответу Meta)`
      );
    } catch (err) {
      // Пара (канал, externalId) уникальна: верный идентификатор уже занят другой
      // записью — значит аккаунт кем-то заведён дважды, и это решает человек.
      if ((err as { code?: string }).code === "P2002") {
        await logSystemError(
          "meta",
          `Instagram-аккаунт «${row.title}» дублируется: идентификатор ${identity.id} уже занят другой записью. Удалите лишний аккаунт в Настройках.`
        );
        continue;
      }
      throw err;
    }
  }

  if (changed) resetAccountsCache();
  return changed;
}

/**
 * Маркер конкретного аккаунта — когда диалог уже привязан.
 *
 * `disabled: true` — аккаунт выключен тумблером в Настройках → Каналы. Токен при этом
 * отдаётся как раньше: ручной ответ сотрудника и проверки здоровья им пользуются. А вот
 * фоновые сообщения от имени бота (напоминания, просьба о номере, повтор зависшего)
 * обязаны пропустить диалог: входящий путь отбирает у выключенного аккаунта токен
 * (resolveIncomingAccount), и исходящий не вправе его обходить (CHANNEL-NEW-11). Подставить
 * вместо него токен общего аккаунта тоже нельзя: meta.ts при пустом токене берёт
 * глобальный, и клиент получил бы сообщение от чужого аккаунта.
 */
export async function accountTokenById(accountId: string | null | undefined, channel: string) {
  if (!accountId) return { ...(await resolveIncomingAccount(channel, undefined)), disabled: false };
  const row = (await loadAccounts()).find((r) => r.id === accountId);
  if (!row) return { ...(await resolveIncomingAccount(channel, undefined)), disabled: false };
  return { id: row.id, title: row.title, token: decryptSecretSafe(row.token) || undefined, disabled: !row.enabled };
}

/** Маркер из старых одиночных полей Settings — путь совместимости. */
async function legacyToken(channel: string): Promise<string | undefined> {
  const config = await loadCredentials();
  if (channel === "INSTAGRAM") return config.igToken;
  if (channel === "FACEBOOK") return config.pageToken;
  if (channel === "WHATSAPP") return config.waToken;
  return undefined;
}

export interface SaveAccountInput {
  id?: string;
  channel: string;
  externalId: string;
  title: string;
  /** Пустая строка при обновлении = маркер не меняем. */
  token?: string;
  /**
   * Секрет приложения Meta, под которым живёт ЭТОТ аккаунт.
   *
   * Нужен, когда второй аккаунт заведён в отдельном приложении: его вебхуки
   * подписаны другим секретом, и без своего секрета они отбиваются 403 ещё до
   * разбора тела — молча (см. meta.ts, verifySignature). Пусто — подпись
   * сверяется общими секретами из Настроек, то есть прежнее поведение.
   *
   * Пустая строка, как и у маркера, означает «не менять».
   */
  appSecret?: string;
  enabled?: boolean;
  isDefault?: boolean;
  /**
   * Идентификаторы получателя, которые Meta никаким запросом не подтвердит
   * (см. schema.prisma, extraExternalIds) — владелец добавляет их руками из
   * текста ошибки «неизвестный получатель» в Настройках → Каналы.
   *
   * `undefined` — не трогать список; массив (в т.ч. пустой) — заменить целиком.
   * Так же, как у токена и промта, различаем «не передано» и «очистить».
   */
  extraExternalIds?: string[];
  /**
   * Своя «личность» бота. В отличие от маркера, ПУСТАЯ строка здесь значима —
   * «убрать свой промт, вернуться к общему из Настроек». Поэтому различаем
   * `undefined` (не трогать) и `""` (очистить), а не отбрасываем пустое.
   */
  systemPrompt?: string | null;
}

/**
 * Создать или обновить аккаунт.
 *
 * Пометка «по умолчанию» снимается с остальных аккаунтов КАНАЛА в той же
 * транзакции: два аккаунта по умолчанию — это молчаливо разные ответы на
 * одинаковые входящие, и разбираться в этом пришлось бы по журналам.
 */
export async function saveAccount(input: SaveAccountInput): Promise<string> {
  const token = input.token?.trim() ? encryptSecret(input.token.trim()) : undefined;
  /**
   * Секрет приложения храним так же, как маркер, — зашифрованным.
   *
   * Записывается через `Record<string, unknown>`, потому что колонка `appSecret`
   * добавляется в схему отдельной миграцией: явное поле в объекте Prisma не
   * собралось бы до неё. Пока колонки нет, объект пуст и ничего не меняется.
   */
  const appSecret: Record<string, unknown> = input.appSecret?.trim()
    ? { appSecret: encryptSecret(input.appSecret.trim()) }
    : {};
  // Пустую строку сохраняем как null: «своего промта нет» — это одно состояние, а
  // не два (пусто и NULL), иначе accountPersona пришлось бы проверять оба.
  const persona = input.systemPrompt === undefined ? undefined : input.systemPrompt?.trim() || null;
  // Чистим и убираем дубликаты/пустые строки — форма присылает то, что человек
  // напечатал построчно или через запятую (см. routes/settings.ts).
  const extraIds =
    input.extraExternalIds === undefined
      ? undefined
      : Array.from(new Set(input.extraExternalIds.map((v) => v.trim()).filter(Boolean)));

  const id = await prisma.$transaction(async (tx) => {
    const saved = input.id
      ? await tx.messengerAccount.update({
          where: { id: input.id },
          data: {
            channel: input.channel,
            externalId: input.externalId.trim(),
            title: input.title.trim(),
            ...(token ? { token } : {}),
            ...appSecret,
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
            ...(persona === undefined ? {} : { systemPrompt: persona }),
            ...(extraIds === undefined ? {} : { extraExternalIds: extraIds }),
          },
        })
      : await tx.messengerAccount.create({
          data: {
            channel: input.channel,
            externalId: input.externalId.trim(),
            title: input.title.trim(),
            token: token ?? "",
            ...appSecret,
            enabled: input.enabled ?? true,
            isDefault: input.isDefault ?? false,
            systemPrompt: persona ?? null,
            extraExternalIds: extraIds ?? [],
          },
        });

    const shouldBeDefault = input.isDefault ?? (await tx.messengerAccount.count({ where: { channel: input.channel } })) === 1;
    if (shouldBeDefault) {
      await tx.messengerAccount.updateMany({
        where: { channel: input.channel, id: { not: saved.id } },
        data: { isDefault: false },
      });
      await tx.messengerAccount.update({ where: { id: saved.id }, data: { isDefault: true } });
    }
    return saved.id;
  });

  resetAccountsCache();
  return id;
}

/** Удаление аккаунта. Диалоги остаются: у них accountId просто обнуляется. */
export async function deleteAccount(id: string): Promise<void> {
  const row = await prisma.messengerAccount.findUnique({ where: { id } });
  if (!row) return;

  // ОДНОЙ ТРАНЗАКЦИЕЙ (22.09.2026): удаление и назначение нового «по умолчанию»
  // раньше шли врозь, и перезапуск процесса между ними оставлял канал совсем без
  // аккаунта по умолчанию — входящее для неизвестного получателя становилось
  // некому ответить, молча, пока кто-нибудь не заглянет в Настройки → Каналы.
  // Соседняя функция в этом файле уже сделана так же.
  await prisma.$transaction(async (tx) => {
    await tx.messengerAccount.delete({ where: { id } });
    if (!row.isDefault) return;
    const next = await tx.messengerAccount.findFirst({
      where: { channel: row.channel, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    if (next) await tx.messengerAccount.update({ where: { id: next.id }, data: { isDefault: true } });
  });

  // Сброс кеша — только после коммита, иначе он перечитает ещё не видимое состояние.
  resetAccountsCache();
}
