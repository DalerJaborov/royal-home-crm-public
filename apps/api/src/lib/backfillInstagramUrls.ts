import { prisma } from "../db.js";
import { getAllOwnMedia } from "../messengers/instagramFeed.js";
import { captionShortId, healInstagramUrl } from "../messengers/sharedMedia.js";
import { logSystemError } from "./systemError.js";

/**
 * Одноразовая (и безопасно повторяемая) починка ссылки на публикацию Instagram
 * у ВСЕХ карточек с непустым полем — не только у тех, где лежит явно не-Instagram
 * строка (t.me, пустая, битая — таких было 17 на 16.08.2026), но и у тех, где
 * ссылка выглядит как Instagram, но ведёт не на ту публикацию (номер в подписи
 * не совпадает с номером карточки). Второй случай не различить регуляркой —
 * только сверкой с лентой, поэтому теперь сверяем ленту у каждой карточки.
 *
 * Логика зеркальна самоисцелению из живого диалога (healInstagramUrl), просто
 * идёт в обратную сторону: там код публикации уже известен и ищется подпись,
 * здесь известен номер карточки и по ленте ищется публикация с этим номером
 * в подписи. healInstagramUrl сам не трогает поле, если код публикации в нём
 * уже совпадает с найденной — поэтому прогон по уже-верным карточкам безопасен
 * и идемпотентен, а не только по подозрительным.
 *
 * 20.08.2026: перешли с getInstagramMedia (последние 25 постов ОДНОГО аккаунта)
 * на getAllOwnMedia (до 300 постов на КАЖДЫЙ подключённый аккаунт, см.
 * instagramFeed.ts) — тот же более глубокий поиск, что 17.08.2026 завели для
 * узнавания пересланных роликов ботом. Первая версия этого скрипта написана
 * 16.08.2026, до появления getAllOwnMedia, и её не перенесли: те же 17 карточек
 * оставались unresolved и три дня спустя, потому что их публикации либо старше
 * последних 25 постов, либо лежат на втором аккаунте (Royal Home Info).
 */
export interface BackfillResult {
  /** Сколько карточек с непустой ссылкой проверено. */
  checked: number;
  /** Карточки, у которых ссылка была неверной (или отсутствовала) и обновлена. */
  fixed: { shortId: number; propertyId: string; permalink: string }[];
  /** Карточки, у которых ссылка сверена с лентой и оказалась уже верной — трогать не пришлось. */
  alreadyCorrect: number;
  /** Карточки, для которых в последних 25 постах подходящей подписи не нашлось —
   *  нужен человек: либо пост старше ленты, либо в подписи нет номера. */
  unresolved: { shortId: number; propertyId: string }[];
}

export async function backfillInstagramUrls(): Promise<BackfillResult> {
  const candidates = await prisma.property.findMany({
    where: { deletedAt: null, instagramUrl: { not: null } },
    select: { id: true, shortId: true, instagramUrl: true },
  });
  const misfilled = candidates.filter((p) => p.instagramUrl?.trim());

  const result: BackfillResult = { checked: misfilled.length, fixed: [], alreadyCorrect: 0, unresolved: [] };
  if (misfilled.length === 0) return result;

  const feed = await getAllOwnMedia();
  if (!feed) {
    // Лента недоступна целиком (нет маркера, Meta отказала) — все карточки уходят
    // в unresolved, а не молча пропадают из отчёта.
    for (const p of misfilled) result.unresolved.push({ shortId: p.shortId, propertyId: p.id });
    void logSystemError("meta", "Починка ссылок на публикации Instagram: лента недоступна, ни одна карточка не проверена");
    return result;
  }

  // Номер → публикация. Если два поста в последних 25 сослались на один номер
  // (переизданный ролик), берём более свежий — feed уже отдаётся от нового к
  // старому (Graph API отдаёт /me/media в этом порядке).
  const byShortId = new Map<number, { permalink: string }>();
  for (const item of feed) {
    const shortId = captionShortId(item.caption);
    if (shortId != null && !byShortId.has(shortId)) byShortId.set(shortId, { permalink: item.permalink });
  }

  for (const p of misfilled) {
    const match = byShortId.get(p.shortId);
    if (!match) {
      result.unresolved.push({ shortId: p.shortId, propertyId: p.id });
      continue;
    }
    const changed = await healInstagramUrl(p.id, p.instagramUrl, match.permalink);
    if (changed) result.fixed.push({ shortId: p.shortId, propertyId: p.id, permalink: match.permalink });
    else result.alreadyCorrect++;
  }

  return result;
}

// Запуск напрямую: `npx tsx src/lib/backfillInstagramUrls.ts` (нужны реальные
// DATABASE_URL и маркер Instagram в Settings — то есть окружение прода или
// стенда с настоящими ключами, не тестовая база). Из тестов и из веб-сервера
// этот блок не выполняется: import.meta.url совпадает с process.argv[1] только
// при прямом запуске файла — тот же приём, что и в prisma/seed.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  backfillInstagramUrls()
    .then((result) => {
      console.log("Готово:", {
        проверено: result.checked,
        уже_было_верно: result.alreadyCorrect,
        починено: result.fixed.length,
        починено_подробно: result.fixed,
        осталось_вручную: result.unresolved.map((u) => u.shortId),
      });
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
