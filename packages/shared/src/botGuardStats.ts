/**
 * СЧЁТЧИКИ ФИЛЬТРОВ ОТВЕТА БОТА ЗА 14 ДНЕЙ — ответ GET /api/v1/settings/bot-guard-stats.
 *
 * Жили на экране «Обучение бота» (/bot-training/guard-stats). Экран удалён 23.11.2026,
 * а счётчики нужны дальше: по ним видно, какую долю ответов нового помощника отбросила
 * проверка и как часто фильтры чинят реплику. Теперь — Настройки → «Бот» → «Проверка бота».
 */
export interface BotGuardFilterTotal {
  /** Латинский ключ фильтра (GuardHit.guard). */
  guard: string;
  /** Подпись по-русски; неизвестный ключ — как есть. */
  label: string;
  count: number;
}

/** Доля отброшенного у нового помощника за окно. Намеренно выключенное (язык, не личные сообщения) в долю не входит. */
export interface BotGuardDropShare {
  /** Сколько вердиктов считается (без намеренно выключенного). */
  total: number;
  dropped: number;
  /** 0..100, целое. */
  sharePercent: number;
  /** Выключено намеренно — показывается рядом, в долю не входит. */
  intentional: number;
  reasons: Array<{ reason: string; count: number }>;
}

export interface BotGuardStatsResponse {
  days: number;
  /** Живая фраза помощника (`say_*`). */
  say: BotGuardDropShare;
  /** Слова модели вокруг фактов (`answer_*`). */
  answer: BotGuardDropShare & { factAttempts: number };
  /** Остальные фильтры: сколько раз исправили ответ или отсеяли нецелевую заявку. */
  filters: BotGuardFilterTotal[];
}
