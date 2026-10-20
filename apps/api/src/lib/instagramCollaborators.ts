/**
 * СОАВТОРЫ INSTAGRAM REELS (26.09.2026) — Graph API принимает в контейнере
 * Reels поле `collaborators`, до 3 ников без `@`. Соавтор получает
 * приглашение, и после принятия пост появляется и в его ленте с теми же
 * просмотрами. Работает для Reels, фото и каруселей, для Историй — нет
 * (ограничение самой площадки, не наше). Источники ников — Settings
 * (`instagramCollaborators`, ники через запятую/пробел/перевод строки,
 * задаёт директор в Настройках) и профиль агента-хозяина объекта
 * (`Agent.instagramUsername`) — см. lib/propertyOwner.ts для того, кто
 * считается хозяином.
 *
 * Разбор — ЧИСТАЯ функция, никакого обращения к базе или сети: вызывающий
 * код (lib/socialPublish.ts::publishApprovedPost) сам достаёт оба значения
 * из уже загруженных Settings/Agent и передаёт сюда строками.
 */

/** Один ник Instagram: латиница/цифры/точка/подчёркивание, до 30 символов —
 *  реальное ограничение площадки на username. Не соответствующие строки
 *  тихо выбрасываются, а не превращаются в отказ Graph API на публикации. */
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

/** «@ali», « Ali_B », «bob.k» → «ali_b» и т.п. — нижний регистр, обрезаны
 *  пробелы и ведущий `@` (площадка ников с `@` в теле запроса не принимает). */
function normalizeUsername(raw: string): string | null {
  const cleaned = raw.trim().replace(/^@+/, "").toLowerCase();
  return USERNAME_RE.test(cleaned) ? cleaned : null;
}

export interface InstagramCollaboratorsInput {
  /** Settings.instagramCollaborators как есть — ники через запятую, пробел
   *  или перевод строки, null/пусто = не заданы. */
  settingsRaw: string | null | undefined;
  /** Agent.instagramUsername хозяина объекта (lib/propertyOwner.ts) — ставится
   *  ПЕРВЫМ в список, если задан и прошёл проверку формата. */
  agentUsername: string | null | undefined;
}

/**
 * Итоговый список соавторов для тела запроса Graph API: ник агента-хозяина
 * первым (если есть), затем ники из настроек — без `@`, без пробелов, без
 * дублей, в нижнем регистре, не длиннее 3 штук (лимит самого API).
 */
export function instagramCollaboratorsFor({ settingsRaw, agentUsername }: InstagramCollaboratorsInput): string[] {
  const ordered: string[] = [];
  if (agentUsername) {
    const normalized = normalizeUsername(agentUsername);
    if (normalized) ordered.push(normalized);
  }
  if (settingsRaw) {
    for (const piece of settingsRaw.split(/[,\s]+/)) {
      if (!piece) continue;
      const normalized = normalizeUsername(piece);
      if (normalized) ordered.push(normalized);
    }
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const username of ordered) {
    if (seen.has(username)) continue;
    seen.add(username);
    deduped.push(username);
    if (deduped.length >= 3) break;
  }
  return deduped;
}
