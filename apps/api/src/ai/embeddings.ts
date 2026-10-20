import { prisma } from "../db.js";
import { resolveGeminiRuntime } from "./geminiSettings.js";
import {
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
  geminiEmbedUrlFor,
  geminiProxyHeaders,
} from "./geminiTransport.js";
import { emptyUsage, logAiCall } from "./shared.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { TYPE_RU, CONDITION_RU, formatPrice } from "./seoGenerator.js";

/**
 * ЭМБЕДДИНГИ GEMINI — семантический подбор объектов (23.08.2026, пункт 3 очереди ИИ).
 *
 * Стиль сознательно ближе к coverImage.ts, чем к geminiClient.ts: это фоновая,
 * не диалоговая функция (индексация карточки, разовый бэкафилл, поиск ассистента),
 * без бюджета в 75 секунд и без резервных моделей — при отказе просто отдаём null,
 * вызывающий код (embedAndSaveProperty) уже не блокирует ничего пользователя.
 */

/** RETRIEVAL_DOCUMENT — текст объекта при индексации; RETRIEVAL_QUERY — текст
 *  запроса клиента при поиске. Асимметричный поиск, разные task_type для двух
 *  сторон — так рекомендует документация Gemini, ощутимо влияет на качество. */
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** Сколько ждём вектор одной попытки. Короче, чем генерация текста/картинки —
 *  embedContent не рассуждает, просто считает. */
const EMBED_TIMEOUT_MS = 20_000;

/** gemini-embedding-001 принимает не больше 2048 токенов на вызов (ai.google.dev/
 *  gemini-api/docs/embeddings, проверено 23.08.2026). Символов на токен для
 *  русского/таджикского текста меньше, чем для английского — берём с запасом
 *  вчетверо ниже теоретического потолка, а не впритык: карточка объекта и так
 *  укладывается на порядок короче, это просто отсечка от случайного мусора. */
const MAX_INPUT_CHARS = 6000;

/**
 * Вектор текста от Gemini, либо null при любом отказе (ключ не настроен, сеть,
 * пустой текст, ответ без вектора). Отказ уже залогирован (logSystemError) —
 * вызывающему коду достаточно молча пропустить объект/запрос.
 */
export async function embedText(text: string, taskType: EmbeddingTaskType): Promise<number[] | null> {
  const trimmed = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!trimmed) return null;

  const started = Date.now();
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) return null;

  const model = GEMINI_EMBEDDING_MODEL;
  const body = JSON.stringify({
    model: `models/${model}`,
    content: { parts: [{ text: trimmed }] },
    taskType,
    outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
  });

  let lastError = "не с чем пробовать";
  // Перебор ключей, как и в coverImage.ts: 401/403 — беда конкретного ключа,
  // остальные коды относятся к модели/проекту и следующий ключ их не изменит.
  for (const apiKey of runtime.keys) {
    try {
      const res = await fetch(geminiEmbedUrlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body,
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
        lastError = `HTTP ${res.status}: ${detail}`;
        if (res.status !== 401 && res.status !== 403) break;
        continue;
      }
      const data = (await res.json()) as { embedding?: { values?: number[] } };
      const values = data.embedding?.values;
      if (!values || values.length === 0) {
        lastError = "Ответ без вектора";
        break;
      }
      void logAiCall({
        endpoint: `embeddings:${taskType.toLowerCase()}`,
        model,
        spent: emptyUsage(),
        ms: Date.now() - started,
        ok: true,
      });
      return values;
    } catch (err) {
      lastError = describeError(err);
    }
  }

  void logSystemError("ai", `Эмбеддинг не получен (${model}): ${lastError}`);
  return null;
}

/** Косинусное сходство двух векторов: 1 — одинаковое направление, 0 — ортогональны,
 *  -1 — противоположное. Чистая функция, без сети и без Prisma — юнит-тестируется
 *  напрямую. Нормализует оба вектора сама (делит на произведение норм), поэтому
 *  усечённый (не перенормированный вручную) вектор gemini-embedding-001 даёт
 *  корректный результат без отдельного шага нормализации при сохранении. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Поля объекта, из которых собирается текст для эмбеддинга — ровно то же
 *  подмножество, что и propertyEmbeddingText ждёт. Отдельным типом, чтобы
 *  вызывающий код (embedAndSaveProperty) явно видел, что именно нужно выбрать
 *  из базы, не утаскивая лишние колонки карточки. */
export interface PropertyForEmbedding {
  title: string;
  type: string;
  rooms: number | null;
  // unknown, а не number: в Prisma это Decimal (см. price/areaSqm в схеме), Number()
  // ниже приводит и Decimal, и обычное число из тестов одинаково.
  areaSqm: unknown;
  price: unknown;
  currency: string;
  district: { name: string } | null;
  // Закрытый объект (offSite) может остаться без адреса вовсе (владелец 14.09.2026) —
  // индексируем как есть, без выдумывания текста.
  address: string | null;
  condition: string;
  amenities: string[];
  description: string | null;
}

/**
 * Текст объекта для индексации — тот самый смысл, который ищет клиент словами
 * («светлая двушка рядом со школой», «есть где детей водить»): структурные поля
 * дают модели опору (тип, комнаты, район, цена), а amenities и description — то
 * свободное описание, которое структурный подбор (routes/matching.ts) не читает
 * вовсе. Порядок — от общего к частному, как в человеческом объявлении.
 *
 * Использует TYPE_RU/CONDITION_RU/formatPrice из ai/seoGenerator.ts — те же
 * человекочитаемые подписи, что уже применяются к SEO-описанию объекта, вместо
 * второй копии тех же трёх словарей.
 */
export function propertyEmbeddingText(property: PropertyForEmbedding): string {
  const parts: string[] = [
    property.title,
    TYPE_RU[property.type] ?? property.type,
    property.rooms != null ? `${property.rooms}-комнатная` : "",
    `${Number(property.areaSqm)} м²`,
    formatPrice(Number(property.price), property.currency),
    property.district?.name ?? "",
    property.address ?? "",
    CONDITION_RU[property.condition] ?? property.condition,
    property.amenities.length > 0 ? property.amenities.join(", ") : "",
    property.description ?? "",
  ];
  return parts.filter((p) => p.trim().length > 0).join(". ");
}

/** Выбор колонок для embedAndSaveProperty — используется и здесь, и в бэкафилл-скрипте,
 *  чтобы оба места не расходились в том, что именно читается из базы. */
export const EMBEDDING_SELECT = {
  title: true,
  type: true,
  rooms: true,
  areaSqm: true,
  price: true,
  currency: true,
  address: true,
  condition: true,
  amenities: true,
  description: true,
  district: { select: { name: true } },
} as const;

/**
 * Поля карточки, от которых зависит текст эмбеддинга — при их изменении на PATCH
 * вектор пересчитывается заново (routes/properties.ts), тем же приёмом, что и
 * SEO_RELEVANT_FIELDS для описания объекта. districtId — а не district.name:
 * правка бьёт по колонке, которую видит Prisma-запрос PATCH. title не входит
 * намеренно: значение всегда пересобирается сервером из type/rooms/districtId
 * (buildPropertyTitle) — те уже в списке, и то, что пришлёт клиент в data.title,
 * на сохранённый заголовок не влияет вовсе.
 */
export const EMBEDDING_RELEVANT_FIELDS = [
  "type",
  "rooms",
  "areaSqm",
  "price",
  "currency",
  "districtId",
  "address",
  "condition",
  "amenities",
  "description",
] as const;

/**
 * Пересчитывает и сохраняет вектор объекта по его id — читает карточку заново из
 * базы (не полагается на то, что передал вызывающий код), поэтому пригодна и для
 * фонового вызова сразу после create/PATCH, и для разового бэкафилла.
 *
 * НИКОГДА НЕ БРОСАЕТ — вызывающий код (routes/properties.ts) зовёт её как
 * `void embedAndSaveProperty(id)`, не блокируя ответ пользователю на создание/
 * правку карточки; отказ эмбеддинга не должен ронять сохранение объекта.
 */
export async function embedAndSaveProperty(propertyId: string): Promise<void> {
  try {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: EMBEDDING_SELECT,
    });
    // Объект удалён/не найден между постановкой в очередь и выполнением — гнаться
    // не за чем, это не ошибка.
    if (!property) return;

    const text = propertyEmbeddingText(property);
    const vector = await embedText(text, "RETRIEVAL_DOCUMENT");
    // embedText уже залогировал причину отказа (ключ не настроен, сеть, лимит) —
    // здесь просто не перезаписываем предыдущий вектор мусором.
    if (!vector) return;

    // Ответ Gemini шёл секунды, а правки описания запускают пересчёт параллельно
    // (crud.ts, `void embedAndSaveProperty`): поздний ответ по СТАРОМУ тексту затирал
    // вектор нового и ставил свежий embeddingUpdatedAt (CHANNEL-NEW-28). Перед записью
    // сверяем текст с текущим состоянием карточки; не совпал, значит есть более новый
    // пересчёт, и он сам запишет свой вектор. updatedAt для сверки не годится: его
    // меняет любая запись, включая сохранение самого вектора.
    const current = await prisma.property.findUnique({ where: { id: propertyId }, select: EMBEDDING_SELECT });
    if (!current || propertyEmbeddingText(current) !== text) return;

    await prisma.property.update({
      where: { id: propertyId },
      data: { embedding: vector, embeddingUpdatedAt: new Date() },
    });
  } catch (err) {
    console.error(`[embeddings] Объект ${propertyId}:`, err);
    void logSystemError("ai", `Эмбеддинг объекта ${propertyId} не сохранён: ${describeError(err)}`);
  }
}
