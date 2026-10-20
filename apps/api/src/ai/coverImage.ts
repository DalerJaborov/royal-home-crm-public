import sharp from "sharp";
import { geminiGenerateUrlFor, geminiProxyHeaders } from "./geminiTransport.js";
import { resolveGeminiRuntime } from "./geminiSettings.js";
import { logSystemError } from "../lib/systemError.js";
import { emptyUsage, logAiCall } from "./shared.js";

/**
 * ОБЛОЖКИ ДЛЯ СТАТЕЙ БЛОГА — рисует CRM, показывает сайт.
 *
 * ПОЧЕМУ РИСУЕТ ИМЕННО CRM, а не сайт напрямую. Ключ Google — секрет, и он уже живёт
 * здесь, зашифрованным в Настройках, под правом `settings.manage`. Отдать его второму
 * проекту значило бы завести вторую копию секрета, второе место, где его менять при
 * ротации, и второй способ его потерять. Ротация 22.08.2026 показала цену такой
 * ошибки наглядно: удалив ключи в консоли Google, владелец мгновенно остановил бота —
 * а если бы копия жила ещё и на сайте, чинить пришлось бы в двух местах, причём про
 * второе никто бы не вспомнил.
 *
 * Поэтому сайт присылает тему статьи и получает готовую картинку. Ключа он не видит
 * никогда, а владелец меняет модель рисования с одного экрана — Настройки → ИИ.
 *
 * РИСУЮЩИЕ МОДЕЛИ РАБОТАЮТ ТОЛЬКО НА ПЛАТНОМ ПРОЕКТЕ GOOGLE. На бесплатном тире их
 * суточная квота равна нулю, и ответ приходит 429 с `quotaId:
 * GenerateRequestsPerDayPerProjectPerModel-FreeTier`, — при том что ТЕКСТОВЫЕ модели
 * тем же ключом отвечают нормально. Отсюда обманчивое «ключ рабочий, а картинки не
 * идут»: дело не в ключе, а в проекте без привязанного биллинга. Проверено живым
 * вызовом 22.08.2026, ошибка распознаётся ниже и объясняется человеческим языком.
 */

/** Сколько ждём картинку. Рисование дольше текста: живой замер 22.08.2026 — около
 *  20 секунд на обложку 1 МБ. Запас двойной, чтобы редкая медленная попытка не
 *  превращалась в отказ. */
const COVER_TIMEOUT_MS = 60_000;

/** Ширина готовой обложки. Больше не нужно: это картинка над статьёй, а не постер, —
 *  а каждый лишний килобайт замедляет сайт на телефоне через мобильный интернет. */
const COVER_WIDTH = 1280;

export interface CoverImageResult {
  ok: boolean;
  /** JPEG обложки; null при отказе. */
  image: Buffer | null;
  /** Человеческая причина отказа — она уходит в журнал CRM и в ответ сайту. */
  error: string | null;
  /** HTTP-код Google, когда он был: по нему видно, чинить биллинг или имя модели. */
  status: number | null;
}

/**
 * Промт обложки.
 *
 * БЕЗ ТЕКСТА НА КАРТИНКЕ — намеренно. Модели рисуют надписи с ошибками, а на
 * таджикском и русском особенно; заголовок статьи сайт кладёт поверх сам, живым
 * шрифтом. Просить нарисовать текст значит гарантированно получать обложки, которые
 * нельзя публиковать.
 */
function buildPrompt(topic: string): string {
  return (
    `Обложка для статьи о недвижимости в Душанбе, Таджикистан. Тема: ${topic}. ` +
    "Фотореалистично, тёплый естественный свет, современная городская архитектура. " +
    "Горизонтальная композиция. БЕЗ текста, букв, цифр, логотипов и водяных знаков."
  );
}

/**
 * Отличаем «проект без биллинга» от прочих 429.
 *
 * Разница принципиальна для того, кто чинит: обычный 429 значит «подожди», а этот —
 * «включи оплату проекту, ожидание не поможет никогда». Одинаковый текст ошибки
 * заставил бы ждать сутками того, что не наступит.
 */
export function explainFailure(status: number, body: string): string {
  if (status === 429 && /FreeTier/i.test(body)) {
    return (
      "Проект Google, которому принадлежит ключ, не подключён к оплате: рисующим моделям " +
      "на бесплатном тарифе не выдаётся ни одного запроса в сутки (текстовые при этом работают). " +
      "Привяжите проект к платёжному аккаунту в AI Studio → Billing."
    );
  }
  if (status === 429) return "Google ограничил частоту запросов — попробуйте через несколько минут.";
  if (status === 404) {
    return "Такой модели у Google нет или она закрыта. Проверьте имя в Настройках → ИИ кнопкой «Проверить».";
  }
  if (status === 401 || status === 403) return "Ключ Gemini отклонён Google — проверьте его в Настройках → ИИ.";
  return `Google ответил ${status}: ${body.slice(0, 200)}`;
}

/** Рисует обложку по теме статьи. Ключ и модель — из Настроек CRM. */
export async function generateCoverImage(topic: string): Promise<CoverImageResult> {
  const started = Date.now();
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) {
    return { ok: false, image: null, error: "Ключ Gemini не настроен", status: null };
  }

  const model = runtime.imageModel;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildPrompt(topic) }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  let last: CoverImageResult = { ok: false, image: null, error: "не с чем пробовать", status: null };

  // Ключи перебираются, как и везде: ключ мог быть отозван, а рисование — не тот
  // случай, где стоит сдаваться на первом отказе (см. ai/geminiSettings.ts).
  for (const apiKey of runtime.keys) {
    try {
      const res = await fetch(geminiGenerateUrlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body,
        signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, " ");
        last = { ok: false, image: null, error: explainFailure(res.status, detail), status: res.status };
        // 401/403 — беда конкретного ключа, следующий может ответить. Остальные коды
        // относятся к модели или к проекту, и перебор ключей их не изменит.
        if (res.status !== 401 && res.status !== 403) break;
        continue;
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) {
        // Ответ без картинки — почти всегда отказ модели рисовать по содержанию
        // запроса. Молчать нельзя: снаружи это неотличимо от поломки сети.
        last = { ok: false, image: null, error: "Модель ответила без изображения", status: res.status };
        break;
      }
      // Приводим к одному формату и размеру: модель возвращает то PNG, то JPEG, и
      // отдавать сайту как придётся значит переложить на него нашу же неопределённость.
      const image = await sharp(Buffer.from(inline.data, "base64"))
        .resize({ width: COVER_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      void logAiCall({
        endpoint: "cover-image:gemini",
        model,
        spent: {
          ...emptyUsage(),
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        ms: Date.now() - started,
        ok: true,
      });
      return { ok: true, image, error: null, status: res.status };
    } catch (err) {
      last = {
        ok: false,
        image: null,
        error: err instanceof Error ? err.message : "неизвестный сбой",
        status: null,
      };
    }
  }

  // В журнал CRM, а не только в ответ сайту: отказ рисования иначе виден лишь тому,
  // кто в этот момент смотрел на сайт, — то есть никому.
  void logSystemError("ai", `Обложка статьи не нарисована (${model}): ${last.error}`);
  return last;
}
