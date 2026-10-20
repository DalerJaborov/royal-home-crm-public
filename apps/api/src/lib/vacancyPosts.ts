/**
 * ПУБЛИКАЦИИ ВАКАНСИИ — НАСТРОЙКА, А НЕ КОНСТАНТА В КОДЕ (17.09.2026).
 *
 * Сущности «пост вакансии» в CRM нет и заводить её ради одной ссылки незачем:
 * findSharedProperty (messengers/sharedMedia.ts) искал код пересланной публикации
 * ТОЛЬКО среди объектов (Property.instagramUrl). Рилс вакансии не находился нигде
 * и попадал в ветку «переслали, но мы не опознали» — а она подсказывает боту
 * фразу «Видео у меня не открылось. Вы такую квартиру ищете?». Кандидату на
 * вакансию. За показ этого ролика заплачено.
 *
 * Список правится на экране Настройки → Бот, одна публикация в строке: маркетинг
 * запускает новый ролик чаще, чем мы выкатываем код.
 */

import { prisma } from "../db.js";

/**
 * Пока владелец ничего не вписал — действует этот список.
 *
 * `DdXBttGMLXT` — реклама вакансии «агент по продажам», идущая прямо сейчас
 * (17.09.2026). Умолчание в коде, а не в колонке: колонка со значением по
 * умолчанию заставила бы владельца удалять чужой код руками, когда ролик сменится.
 */
export const DEFAULT_VACANCY_POST_CODES = ["DdXBttGMLXT"];

/**
 * Короткий код публикации Instagram из строки: принимаем и ссылку целиком, и
 * один код. Тот же вид кода, что достаёт instagramShortcode в sharedMedia.ts —
 * сравнивать надо одинаковое.
 */
function codeOf(line: string): string | null {
  const raw = line.trim();
  if (!raw) return null;
  const fromUrl = raw.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (fromUrl) return fromUrl[1];
  const bare = raw.match(/^[A-Za-z0-9_-]{5,}$/);
  return bare ? raw : null;
}

/** Разбор настройки в список кодов. Пусто — умолчание из кода. */
export function parseVacancyPostCodes(setting: string | null | undefined): string[] {
  const codes = (setting ?? "")
    .split(/[\r\n,;]+/)
    .map(codeOf)
    .filter((c): c is string => !!c);
  return codes.length > 0 ? codes : DEFAULT_VACANCY_POST_CODES;
}

/**
 * Список кодов из настроек. Отказ базы = умолчание: тише промолчать про новый
 * ролик, чем ответить кандидату «видео не открылось».
 */
export async function loadVacancyPostCodes(): Promise<string[]> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botVacancyPostCodes: true },
    });
    return parseVacancyPostCodes(s?.botVacancyPostCodes);
  } catch {
    return DEFAULT_VACANCY_POST_CODES;
  }
}

/** Этот код публикации — наша реклама вакансии? */
export async function isVacancyPostCode(code: string | null | undefined): Promise<boolean> {
  if (!code) return false;
  const codes = await loadVacancyPostCodes();
  return codes.some((c) => c.toLowerCase() === code.toLowerCase());
}
