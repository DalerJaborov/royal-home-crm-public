/**
 * ЕЖЕДНЕВНАЯ ПОДБОРКА СТОРИС (28.09.2026, решение владельца 26.09.2026: сторис
 * не только по событиям — снижение цены, «продано», ролик монтажёра, — а
 * КАЖДЫЙ ДЕНЬ несколько объектов сами по себе, чтобы аудитория видела не
 * только новинки). Публикует карточку объекта (CARD) через
 * publishPropertyCardStory (lib/instagramStories.ts) — та же механика, что и у
 * ручной кнопки «Выложить карточку» в карточке объекта, `force: true`, так что
 * Instagram/Facebook публикуются по своим тумблерам независимо от
 * Settings.instagramStoriesEnabled/facebookStoriesEnabled (эти два рубильника
 * решают ТОЛЬКО площадку, не «публиковать ли вообще» — за это отвечает
 * Settings.dailyStoriesEnabled ниже).
 *
 * ВЫБОР ОБЪЕКТОВ: status AVAILABLE, offSite: false (свои объекты сайта — не
 * чужие, поделённые агентом), хотя бы одна фотография, без единой строки
 * PropertyStoryPost (любого канала) за последние 7 дней — подборка не должна
 * повторять то, что уже недавно было в сторис по другому поводу (снижение
 * цены, ручная кнопка). Порядок: сперва те, у кого сторис не было дольше
 * всего (или не было никогда — NULL идёт первым), затем более новые объекты
 * (postApprovedAt desc) — недавно одобренный объект имеет больше шансов
 * попасть в подборку раньше старого, если оба ни разу не публиковались.
 *
 * КРОН И ЗАЩИТА ОТ ВТОРОГО ПРОГОНА — в cron.ts (runDailyStoriesTick сам
 * решает, наступил ли нужный час и не запускались ли мы уже сегодня, через
 * Settings.dailyStoriesLastRunAt; тик крона зовёт эту функцию каждые 15 минут
 * и просто выходит, если рано или уже было). Асинхронная пауза 20 секунд
 * между объектами (не залпом) — тот же довод, что у расписания публикаций
 * Reels: площадки хуже воспринимают пачку однотипных запросов подряд.
 */
import { prisma } from "../db.js";
import { publishPropertyCardStory } from "./instagramStories.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { dushanbeWallClock, dushanbeStartOfToday } from "./dushanbeTime.js";

// process.env.VITEST (тот же приём, что lib/sms/index.ts::isDryRun) — под
// тестом реальные 20 секунд между объектами ничего не проверяют, только
// тратят время прогона; пачка из нескольких объектов не нужна тесту вживую.
const PAUSE_BETWEEN_PROPERTIES_MS = process.env.VITEST ? 0 : 20_000;
/** Не повторять подборкой то, что уже было в сторис (любым каналом, любым
 *  поводом) за последнюю неделю. */
const RECENT_STORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DailyStoryCandidate {
  id: string;
  /** MAX(PropertyStoryPost.publishedAt) по объекту, любой канал — null, если истории не было никогда. */
  lastStoryAt: Date | null;
  postApprovedAt: Date | null;
}

/**
 * Порядок подборки: сначала объекты, у кого сторис не было дольше всего (или
 * не было никогда — null раньше любой реальной даты), затем внутри одной
 * группы — более новые (postApprovedAt desc). Чистая функция (вынесена
 * отдельно 28.09.2026, тот же приём, что у planStorySegments в
 * lib/instagramStories.ts) — тест не должен зависеть от того, что ещё лежит
 * в БД стенда: сортировка проверяется на выдуманных входных данных, а выбор
 * СПИСКА кандидатов (AVAILABLE/offSite/фото/7 дней) — отдельным, DB-тестом.
 */
export function rankDailyStoryCandidates(candidates: DailyStoryCandidate[]): DailyStoryCandidate[] {
  return [...candidates].sort((a, b) => {
    // Никогда не публиковавшиеся (null) — раньше всех остальных.
    if (!a.lastStoryAt && b.lastStoryAt) return -1;
    if (a.lastStoryAt && !b.lastStoryAt) return 1;
    if (a.lastStoryAt && b.lastStoryAt) {
      const diff = a.lastStoryAt.getTime() - b.lastStoryAt.getTime();
      if (diff !== 0) return diff;
    }
    // Внутри одной группы (обе никогда, либо совпало время) — новые объекты раньше.
    const aApproved = a.postApprovedAt?.getTime() ?? 0;
    const bApproved = b.postApprovedAt?.getTime() ?? 0;
    return bApproved - aApproved;
  });
}

export interface DailyStoriesTickResult {
  /** false — рубильник выключен, не наш час, или сегодня уже запускали. */
  ran: boolean;
  reason?: string;
  candidateCount?: number;
  published?: number;
  failed?: number;
}

/**
 * `now` — параметр (не всегда `new Date()` внутри), чтобы тест мог передать
 * фиксированный момент вместо того, чтобы гоняться за реальными часами и
 * часовым поясом Душанбе.
 */
export async function runDailyStoriesTick(now: Date = new Date()): Promise<DailyStoriesTickResult> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { dailyStoriesEnabled: true, dailyStoriesCount: true, dailyStoriesHourDushanbe: true, dailyStoriesLastRunAt: true },
  });
  if (!settings?.dailyStoriesEnabled) return { ran: false, reason: "выключено" };

  const currentHour = dushanbeWallClock(now).getUTCHours();
  if (currentHour !== settings.dailyStoriesHourDushanbe) return { ran: false, reason: "не тот час" };

  const todayStart = dushanbeStartOfToday(now);
  if (settings.dailyStoriesLastRunAt && settings.dailyStoriesLastRunAt >= todayStart) {
    return { ran: false, reason: "сегодня уже запускали" };
  }

  const count = Math.max(1, settings.dailyStoriesCount || 3);
  const recentCutoff = new Date(now.getTime() - RECENT_STORY_WINDOW_MS);

  // Отметка «сегодня уже запускали» ставится ДО самой публикации (не после):
  // публикация идёт минутами (пауза 20с × count), а тик крона приходит каждые
  // 15 минут — без ранней отметки повторный тик в тот же час запустил бы
  // вторую подборку поверх ещё не законченной первой.
  await prisma.settings.update({ where: { id: "singleton" }, data: { dailyStoriesLastRunAt: now } });

  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      status: "AVAILABLE",
      offSite: false,
      photos: { some: {} },
      storyPosts: { none: { publishedAt: { gte: recentCutoff } } },
    },
    select: { id: true, postApprovedAt: true, storyPosts: { orderBy: { publishedAt: "desc" }, take: 1, select: { publishedAt: true } } },
    take: 500,
  });

  const ranked = rankDailyStoryCandidates(
    candidates.map((p) => ({ id: p.id, lastStoryAt: p.storyPosts[0]?.publishedAt ?? null, postApprovedAt: p.postApprovedAt }))
  );

  const chosen = ranked.slice(0, count);
  let published = 0;
  let failed = 0;

  for (let i = 0; i < chosen.length; i++) {
    if (i > 0) await sleep(PAUSE_BETWEEN_PROPERTIES_MS);
    try {
      const summary = await publishPropertyCardStory(chosen[i].id, { force: true });
      if (summary.publishedParts > 0) published++;
      else failed++;
    } catch (err) {
      failed++;
      void logSystemError("meta", `Ежедневная подборка сторис (объект ${chosen[i].id}) упала неожиданно: ${describeError(err)}`);
    }
  }

  return { ran: true, candidateCount: candidates.length, published, failed };
}
