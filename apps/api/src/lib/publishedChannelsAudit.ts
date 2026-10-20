import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { updatePublishedMarks } from "./publishedMarks.js";
import { decryptSecretSafe } from "../crypto.js";
import { loadCredentials } from "../messengers/meta.js";
import {
  checkFacebookVideoExists,
  checkInstagramMediaExists,
  checkYouTubeVideoExists,
  type PresenceResult,
  type YouTubeCredentials,
} from "./socialPublish.js";

/**
 * ЕЖЕСУТОЧНАЯ СВЕРКА: ЧТО МЫ СЧИТАЕМ ОПУБЛИКОВАННЫМ — И ЧТО РЕАЛЬНО ВИСИТ
 * (22.09.2026, владелец: «сверка с тем, что реально в Instagram, YouTube и
 * Facebook»).
 *
 * ЗАЧЕМ. `Property.publishedChannels` — не справка для человека, а РЕШЕНИЕ:
 * `videoHandoff.ts::skipChannels` пропускает каналы из этого списка, поэтому
 * канал, помеченный опубликованным, больше никогда не получит нового ролика.
 * Пост при этом мог давно исчезнуть — его сняли руками в приложении, удалила
 * площадка, он потерялся при переносе аккаунта. Узнать об этом было неоткуда:
 * случай №112 нашёлся только потому, что владелец сам заметил пустое место, а
 * кнопка «Убрать из соцсетей» на нём же и споткнулась (см. isGhostObjectError
 * в socialPublish.ts). Эта сверка ищет такие фантомы сама, раз в сутки.
 *
 * ЧТО ДЕЛАЕТ С НАХОДКОЙ: вычёркивает канал из `publishedChannels` и убирает
 * его id из `publishedPostIds`. Ничего не публикует и никуда не пишет постов —
 * просто перестаёт врать механизмам, что пост там есть. Дальше объект ведёт
 * себя как никогда не публиковавшийся в этом канале, то есть ровно так, как
 * есть на самом деле.
 *
 * ТРИ ИСХОДА ПРОБЫ, И ТОЛЬКО ОДИН ИЗ НИХ ЧТО-ТО МЕНЯЕТ (см. PresenceResult):
 * `gone` — площадка прямо сказала, что объекта нет; `present` — висит;
 * `unknown` — мы НЕ ЗНАЕМ (сеть, токен, квота). На `unknown` не делается
 * ничего: вычеркнуть живой пост дороже, чем подождать сутки до следующего
 * прохода. Молчать при этом тоже нельзя — накопленные `unknown` уходят в
 * журнал одной строкой за проход, иначе сломанный токен выглядел бы как
 * «сверка прошла, всё в порядке».
 *
 * ЧЕГО СВЕРКА НЕ КАСАЕТСЯ И ПОЧЕМУ:
 *  - TELEGRAM — Bot API не даёт спросить «существует ли сообщение»
 *    (getMessage нет вовсе, а правка-проба переписала бы живой пост);
 *  - TIKTOK — Content Posting API не отдаёт ни чтения поста, ни его id
 *    (см. publishedPostIds в schema.prisma);
 *  - THREADS (23.09.2026) — технически проверяемо (`GET /{post_id}?fields=id`
 *    отвечает так же, как у Facebook/Instagram), но решение по умолчанию этой
 *    правки — НЕ добавлять: у канала считаные дни жизни в проде, сверку стоит
 *    заводить вместе со следующим шагом (статистика Threads), а не заранее.
 *    Пока непроверяемый, как TikTok — см. отчёт задания;
 *  - INSTAGRAM без `metaIgManageToken` — тем же доводом, что и в
 *    publishedVideoFix.ts: продукт `metaIgToken` ходит через прокси на
 *    graph.instagram.com и на чужой/удалённый media отвечает неотличимо;
 *  - канал в publishedChannels БЕЗ сохранённого id — проверять нечем.
 *    Это не фантом и не повод вычёркивать: у объектов, опубликованных до
 *    20.09.2026, id просто не сохранялся. Такие каналы сверка считает
 *    непроверяемыми и не трогает (поиск по ленте, как в removeFromSocial,
 *    стоит до трёхсот запросов на КАЖДУЮ карточку — за ночной проход по
 *    сотням карточек это выбрало бы всю квоту Graph API).
 */

/**
 * Ключ в `publishedPostIds`, где лежит время последней сверки этой карточки
 * (ISO-строкой). Отдельной колонки нет по тому же доводу, что у
 * `TIKTOK_PENDING_AT` и `FACEBOOK_PENDING_AT` (socialPublish.ts): миграции на
 * этом сервере накатываются руками, а все читатели поля берут ключи по именам
 * каналов поимённо, и лишний служебный ключ им не мешает.
 *
 * Метка нужна для ОЧЕРЕДИ: за один проход проверяется не больше
 * `PROPERTIES_PER_RUN` карточек, и следующей ночью первыми идут те, кого
 * смотрели раньше всех. Без метки бюджет прохода всегда доставался бы одной и
 * той же голове списка, а хвост не проверялся бы никогда.
 */
const AUDIT_AT_KEY = "AUDIT_CHECKED_AT";

/**
 * Сколько карточек берём за проход. Каждая стоит до трёх запросов к чужим API
 * (Facebook, Instagram, YouTube), то есть потолок прохода — около 450
 * обращений: заметно, но далеко от суточных лимитов Graph API и YouTube Data
 * API, и это ЕДИНСТВЕННАЯ наша ночная нагрузка на них. Карточек с
 * публикациями в базе порядка сотен, так что полный круг занимает день-два,
 * а не недели.
 */
const PROPERTIES_PER_RUN = 150;

/** Не проверяем карточку повторно чаще раза в сутки — смысл сверки в обходе
 *  всех, а не в частом возврате к одним и тем же. */
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PublishedChannelsAuditResult {
  /** Сколько карточек реально опросили. */
  checked: number;
  /** Сколько каналов вычеркнуто как фантомы. */
  cleared: number;
  /** Сколько КАРТОЧЕК остались с «не знаем» хотя бы по одной пробе. */
  unknown: number;
}

interface Candidate {
  id: string;
  publishedChannels: string[];
  publishedPostIds: Record<string, string>;
  checkedAt: number;
}

async function youtubeCredentials(): Promise<YouTubeCredentials> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
  });
  return {
    clientId: settings?.youtubeClientId ?? undefined,
    clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined,
  };
}

async function instagramManageToken(): Promise<string | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true },
  });
  return decryptSecretSafe(settings?.metaIgManageToken ?? null);
}

/**
 * Очередь на этот проход: карточки с непустым `publishedChannels`, у которых
 * есть хоть один проверяемый канал, давно не смотренные — первыми.
 *
 * Сортировка в JS, а не в SQL, намеренно: время сверки лежит внутри JSON, и
 * `ORDER BY` по ключу JSON в Prisma не выражается без сырого запроса. Строк
 * здесь порядка сотен (объект с публикацией — это объект с готовым роликом),
 * колонки берём только нужные, так что читать их целиком дешевле, чем
 * заводить ради сортировки сырой SQL и отдельную колонку с миграцией.
 */
function pickQueue(rows: Candidate[], now: number): Candidate[] {
  return rows
    .filter((row) => now - row.checkedAt >= RECHECK_AFTER_MS)
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .slice(0, PROPERTIES_PER_RUN);
}

/**
 * `propertyIds` — сузить проход до перечисленных карточек. Крон его не
 * передаёт и проходит по всем; нужен тестам, которые работают в ОБЩЕЙ базе
 * рядом с карточками других файлов (см. CLAUDE.md, тесты сервера идут в два
 * процесса на одной базе) и иначе зависели бы от того, чьи карточки первыми
 * попали в бюджет прохода.
 */
export async function runPublishedChannelsAuditTick(
  now: Date = new Date(),
  options?: { propertyIds?: string[] }
): Promise<PublishedChannelsAuditResult> {
  const properties = await prisma.property.findMany({
    where: {
      deletedAt: null,
      NOT: { publishedChannels: { isEmpty: true } },
      ...(options?.propertyIds ? { id: { in: options.propertyIds } } : {}),
    },
    select: { id: true, publishedChannels: true, publishedPostIds: true },
    // Предел выборки: проход берёт самые давние карточки, читать всю таблицу незачем.
    take: 2000,
  });

  const candidates: Candidate[] = properties.map((p) => {
    const ids = (p.publishedPostIds ?? {}) as Record<string, string>;
    const parsed = Date.parse(ids[AUDIT_AT_KEY] ?? "");
    return {
      id: p.id,
      publishedChannels: p.publishedChannels ?? [],
      publishedPostIds: ids,
      // Метки нет (карточка ни разу не сверялась) — считаем «очень давно»,
      // такие идут первыми.
      checkedAt: Number.isFinite(parsed) ? parsed : 0,
    };
  });

  const queue = pickQueue(candidates, now.getTime());
  if (queue.length === 0) return { checked: 0, cleared: 0, unknown: 0 };

  // Ключи и токены читаются ОДИН раз на проход, а не на карточку: это те же
  // Settings, и сотня лишних чтений базы за ночь ничего не даёт.
  const [creds, manageToken, ytCreds] = await Promise.all([
    loadCredentials(),
    instagramManageToken(),
    youtubeCredentials(),
  ]);

  let cleared = 0;
  const unknowns: string[] = [];
  const unknownProperties = new Set<string>();

  for (const property of queue) {
    const probes: { channel: string; result: PresenceResult }[] = [];
    const ids = property.publishedPostIds;

    if (property.publishedChannels.includes("FACEBOOK") && ids.FACEBOOK && creds.pageToken) {
      let result = await checkFacebookVideoExists(ids.FACEBOOK, creds.pageToken);
      // Второй идентификатор того же поста (PublishResult.secondaryPostId):
      // у поста страницы video id и post_id — разные объекты Graph API, и
      // пропажа первого ещё не означает, что поста нет. Вычёркиваем, только
      // когда площадка сказала «нет» про ОБА.
      if (result.status === "gone" && ids.FACEBOOK_POST) {
        result = await checkFacebookVideoExists(ids.FACEBOOK_POST, creds.pageToken);
      } else if (result.status === "unknown" && ids.FACEBOOK_POST) {
        // Первый id не читается вовсе (28.09.2026: «(#12) singular statuses API
        // is deprecated» — старый вид поста Graph API больше не отдаёт). Пост
        // живой, если его видно по второму id; «нет» по второму при «не знаю»
        // по первому — всё ещё «не знаю», вычёркивать по нему нельзя.
        const byPost = await checkFacebookVideoExists(ids.FACEBOOK_POST, creds.pageToken);
        if (byPost.status === "present") result = byPost;
      }
      probes.push({ channel: "FACEBOOK", result });
    }

    if (property.publishedChannels.includes("INSTAGRAM") && ids.INSTAGRAM && manageToken) {
      probes.push({ channel: "INSTAGRAM", result: await checkInstagramMediaExists(ids.INSTAGRAM, manageToken) });
    }

    if (property.publishedChannels.includes("YOUTUBE") && ids.YOUTUBE) {
      probes.push({ channel: "YOUTUBE", result: await checkYouTubeVideoExists(ytCreds, ids.YOUTUBE) });
    }

    const gone = probes.filter((p) => p.result.status === "gone").map((p) => p.channel);
    for (const probe of probes) {
      if (probe.result.status === "unknown") {
        unknowns.push(`${property.id}/${probe.channel}: ${probe.result.reason}`);
        unknownProperties.add(property.id);
      }
    }

    // ЗАПИСЬ — ДЕЛЬТОЙ К СВЕЖЕЙ КАРТОЧКЕ, а не снимком, прочитанным в начале прохода
    // (аудит 04.10.2026, PUB07): за время внешних проб (до 150 карточек подряд)
    // параллельная публикация могла сохранить новый id или канал, и запись всего
    // старого publishedPostIds уничтожала бы его. Вычёркиваем только то, что проба
    // признала несуществующим И что в карточке всё ещё тот же id: если там уже новый
    // (канал опубликован заново), «поста нет» относится к прежнему и не про него.
    let actuallyGone: string[] = [];
    const { applied } = await updatePublishedMarks(property.id, (current) => {
      const nextIds: Record<string, unknown> = { ...current.postIds, [AUDIT_AT_KEY]: now.toISOString() };
      actuallyGone = gone.filter((channel) => current.postIds[channel] === ids[channel]);
      for (const channel of actuallyGone) {
        delete nextIds[channel];
        if (channel === "FACEBOOK") delete nextIds.FACEBOOK_POST;
      }
      return {
        channels: actuallyGone.length > 0 ? current.channels.filter((c) => !actuallyGone.includes(c)) : current.channels,
        postIds: nextIds,
        // instagramUrl — «объект показан в Instagram», и на нём же висит одно
        // из условий выхода в продажу (propertyPipeline.ts::blockersForSale).
        // Поста нет — ссылка ведёт в никуда, и оставленная, она заставила бы
        // повторную публикацию считать, что там всё ещё что-то висит. Тот же
        // шаг делает removeFromSocial (publishedVideoFix.ts).
        ...(actuallyGone.includes("INSTAGRAM") ? { data: { instagramUrl: null } } : {}),
      };
    });

    if (applied && actuallyGone.length > 0) {
      cleared += actuallyGone.length;
      // В журнал КАЖДУЮ находку отдельной строкой, а не сводкой: это не
      // поломка интеграции, а расхождение по конкретной карточке, и владельцу
      // нужен её номер, чтобы решить, публиковать ли ролик заново.
      void logSystemError(
        "meta",
        `Сверка публикаций: объект ${property.id} числился опубликованным в ${actuallyGone.join(", ")}, ` +
          `но поста там нет — отметка снята, канал снова свободен для публикации`,
        { dedupKey: `published-channels-audit:${property.id}` }
      );
    }
  }
  if (unknowns.length > 0) {
    // Одной строкой на проход и со стабильным ключом дедупликации: сломанный
    // токен даёт `unknown` на каждой карточке подряд, и без этого журнал
    // получил бы полторы сотни одинаковых записей за ночь.
    void logSystemError(
      "meta",
      `Сверка публикаций: не удалось проверить ${unknownProperties.size} карточек из ${queue.length} (проб: ${unknowns.length}) — ` +
        unknowns.slice(0, 5).join("; "),
      { dedupKey: "published-channels-audit:unknown" }
    );
  }

  return { checked: queue.length, cleared, unknown: unknownProperties.size };
}
