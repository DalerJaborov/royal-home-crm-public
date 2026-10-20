import { geminiGenerateUrlFor, geminiProxyHeaders } from "./geminiTransport.js";
import { resolveGeminiRuntime } from "./geminiSettings.js";
import { explainFailure } from "./coverImage.js";
import { mimeForExt } from "./photoEnhance.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { emptyUsage, logAiCall } from "./shared.js";

/**
 * СВЕТОВАЯ ОБРАБОТКА ФОТО ДЛЯ ОБЛОЖКИ ОБЪЕКТА ЧЕРЕЗ GEMINI (владелец 21.09.2026,
 * тред обложек — «мне твои обложки не понравились, сделай из моего референса
 * через Gemini»).
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПРАВКА `lib/video/coverPoster.ts` НАПРЯМУЮ.
 * `coverPoster.ts` — детерминированный рендер (см. его докстринг: тот же
 * шаблон/шрифт/логотип/координаты на каждый прогон, ради стопроцентного
 * повтора). Этот файл — противоположность: вызов рисующей модели, результат
 * которого меняется от прогона к прогону. `coverPoster.ts` зовёт эту функцию
 * ОПЦИОНАЛЬНО, как шаг обработки ФОТО перед тем, как наложить свой текстовый
 * слой — граница между «то, что обязано быть точным» (цифры, цена, логотип) и
 * «то, что может быть художественным» (свет, цвет, атмосфера) остаётся внутри
 * кода, а не в тексте промта, который модель может нарушить.
 *
 * ПОЧЕМУ МОДЕЛЬ НЕ РИСУЕТ ТЕКСТ/ЛОГОТИП — та же причина, что у `ai/coverImage.ts`
 * и `ai/photoEnhance.ts`: модели рисуют надписи с ошибками, особенно на
 * таджикском, а логотип, который лицензия и бриф владельца требуют оставить
 * НЕИЗМЕНЁННЫМ, при перерисовке моделью каждый раз выходит немного другим
 * (см. `logo-compare.png` в треде — сравнение уже проводилось для обложек
 * статей блога). Поэтому промт просит только световую/цветовую обработку, а
 * текст и логотип `coverPoster.ts` накладывает СВОИМ SVG-слоем поверх
 * результата этой функции — ровно как поверх обычного фото.
 *
 * ТРИ ЗАПРЕТА ПРОМТА — СЛОВО В СЛОВО СОГЛАСНО `ai/photoEnhance.ts`: живой тест
 * 22.08.2026 показал, что расплывчатый запрет модель не держит, и одного
 * упоминания недостаточно — юрист (в данном случае брифа) обязан перечислить
 * это прямым текстом, иначе результат перестаёт быть тем же помещением.
 */

const STYLE_TIMEOUT_MS = 60_000;

function buildCoverStylePrompt(): string {
  return (
    "Отредактируй это фото объекта недвижимости для яркой премиальной обложки соцсетей агентства " +
    "недвижимости — той же механикой, что обработка фото для каталога (свет, баланс белого, резкость, " +
    "шумоподавление, цветокоррекция), но заметно смелее: картинка должна быть ЯРКОЙ, СОЧНОЙ и ТЁПЛОЙ, " +
    "не тусклой и не серой. " +
    "РАЗРЕШЕНО: сделать сцену светлой и солнечной — яркий тёплый солнечный свет из окон, солнечные " +
    "блики и пятна света на полу и стенах, как в золотой час; поднять насыщенность и сочность цвета " +
    "(тёплые золотисто-медовые тона, голубое небо и зелень за окном), поднять контраст и глубину, " +
    "чистые белые без серой пелены, чёткие детали. " +
    "СТРОГО ЗАПРЕЩЕНО, даже если кажется уместным для обложки: " +
    "удалять, добавлять или перемещать любые предметы, мебель, вещи, строительный мусор или что-либо ещё, видимое на фото; " +
    "менять планировку, пропорции, форму или размеры помещения; " +
    "двигать, добавлять или убирать стены, окна, двери, потолок или пол; " +
    "менять ракурс, ширину кадра или композицию; " +
    "рисовать любой текст, буквы, цифры, логотипы или водяные знаки — они накладываются отдельным " +
    "слоем поверх готового результата, а не самой моделью. " +
    "Результат обязан показывать РОВНО ТО ЖЕ помещение с РОВНО ТЕМИ ЖЕ предметами в тех же местах, " +
    "что и на исходном фото — редактируй присланное изображение, а не рисуй новое похожее."
  );
}

export interface CoverPosterStyleResult {
  ok: boolean;
  /** PNG/JPEG (что вернул Google) необработанного результата — вызывающий сам
   *  прогоняет через sharp под нужный размер, как и обычное фото. */
  image: Buffer | null;
  error: string | null;
  status: number | null;
}

/**
 * Отправляет фото Gemini как image-to-image (та же механика, что
 * `ai/photoEnhance.ts`: входное фото — `inlineData`-часть рядом с текстовым
 * промтом, `generateContent` с `responseModalities: ["IMAGE"]`) и возвращает
 * стилизованный результат. Ключ и модель рисования — из Настроек
 * (`resolveGeminiRuntime`), не из `.env` этой сессии: то же разделение
 * секретов, что у остальных вызовов Gemini в проекте.
 *
 * Отказ (нет ключа, Google недоступен, модель отказала) НЕ бросает исключение —
 * вызывающий (`coverPoster.ts`) решает сам, откатиться ли на исходное фото без
 * стилизации; полный отказ обложки из-за недоступного Gemini был бы хуже, чем
 * обложка без художественной обработки.
 */
export async function stylizeCoverPhotoWithGemini(
  sourceBuffer: Buffer,
  sourceFilename: string
): Promise<CoverPosterStyleResult> {
  const started = Date.now();
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) {
    return { ok: false, image: null, error: "Ключ Gemini не настроен", status: null };
  }

  const model = runtime.imageModel;
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: buildCoverStylePrompt() },
          { inlineData: { mimeType: mimeForExt(sourceFilename), data: sourceBuffer.toString("base64") } },
        ],
      },
    ],
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  let last: CoverPosterStyleResult = { ok: false, image: null, error: "не с чем пробовать", status: null };

  // Перебор ключей — тот же приём, что и у остальных вызовов Gemini (см.
  // ai/coverImage.ts, ai/photoEnhance.ts): 401/403 — беда конкретного ключа.
  for (const apiKey of runtime.keys) {
    try {
      const res = await fetch(geminiGenerateUrlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body,
        signal: AbortSignal.timeout(STYLE_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, " ");
        last = { ok: false, image: null, error: explainFailure(res.status, detail), status: res.status };
        if (res.status !== 401 && res.status !== 403) break;
        continue;
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) {
        last = { ok: false, image: null, error: "Модель ответила без изображения", status: res.status };
        break;
      }
      void logAiCall({
        endpoint: "cover-poster-style:gemini",
        model,
        spent: {
          ...emptyUsage(),
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        ms: Date.now() - started,
        ok: true,
      });
      return { ok: true, image: Buffer.from(inline.data, "base64"), error: null, status: res.status };
    } catch (err) {
      last = { ok: false, image: null, error: describeError(err), status: null };
    }
  }

  void logSystemError("ai", `Световая обработка обложки объекта через Gemini не удалась (${model}): ${last.error}`);
  return last;
}
