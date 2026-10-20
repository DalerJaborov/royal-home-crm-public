import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import {
  GEMINI_MODEL,
  GEMINI_FALLBACK_MODELS,
  GEMINI_IMAGE_MODEL,
  GEMINI_TRANSCRIBE_MODELS,
  isKnownGeminiModel,
  retiredGeminiModelReason,
} from "./geminiTransport.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * ЧТО ИМЕННО СПРАШИВАТЬ У GOOGLE: ключи и имена моделей — из Настроек, а не только
 * из .env сервера.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ПОНАДОБИЛОСЬ. За август Google закрыл две модели: gemini-2.5-flash
 * 02.08 и gemini-2.5-pro 22.08.2026. Оба раза — молча, с HTTP 404 на каждый вызов, и
 * оба раза бот продолжал работать на резервной модели (медленнее и дороже), пока
 * у кого-нибудь не доходили руки войти на сервер по SSH и поправить .env. Второй
 * случай прожил трое суток и стоил двойной цены на каждом голосовом.
 *
 * Имя модели — расходник, а не архитектура: оно меняется чаще, чем выкатывается код.
 * Поэтому оно переезжает туда же, где живут ключи, — в Настройки, под руку владельцу.
 *
 * ПОРЯДОК ИСТОЧНИКОВ ВЕЗДЕ ОДИН: `Настройки || .env || дефолт из кода`. Пустая
 * настройка — это «не заполнено», а не «пусто»: установка, где в Настройки ничего не
 * вписали, ведёт себя ровно как до появления этих полей. Так же, как уже сделано для
 * ключей (см. поля geminiApiKey* в Settings).
 *
 * ОДИН ЗАПРОС К БАЗЕ НА ВСЁ. Это горячий путь: каждый ход диалога, каждое голосовое,
 * каждая озвучка. Ключи и модели нужны одному и тому же вызову в одну и ту же
 * секунду, поэтому читаются вместе — второй запрос ради соседней колонки здесь лишний.
 */
export interface GeminiRuntime {
  /** Ключи по порядку перебора; пустой список — Gemini не настроен вовсе. */
  keys: string[];
  /** Основная модель диалогов и разбора текста. */
  model: string;
  /** Резервные модели диалогов, по очереди после основной. */
  fallbackModels: string[];
  /** Дорогие модели расшифровки голосовых, по очереди. */
  transcribeModels: string[];
  /** Модель рисования обложек. */
  imageModel: string;
  /** Дешёвая ступень для простых задач; пустая строка — не настроена, и простые
   *  задачи идут обычной моделью диалогов. */
  liteModel: string;
  /** Явный кэш системного промта (Settings.geminiExplicitCachingEnabled). Выключен —
   *  запросы собираются ровно как раньше, побайтово; см. ai/geminiCache.ts. */
  explicitCaching: boolean;
}

/** Непустое значение настройки или следующий источник. Пустая строка и пробелы —
 *  это «не заполнено»: очистить поле в интерфейсе значит вернуться к .env, а не
 *  отправить запрос к модели с пустым именем. */
function firstFilled(...candidates: (string | null | undefined)[]): string {
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** Непустой список или следующий источник — та же логика для списков моделей. */
function firstFilledList(...candidates: (string[] | null | undefined)[]): string[] {
  for (const list of candidates) {
    const cleaned = (list ?? []).map((m) => m.trim()).filter(Boolean);
    if (cleaned.length > 0) return cleaned;
  }
  return [];
}

/** Поля Настроек, из которых складываются имена моделей. Отдельным типом, потому что
 *  ими пользуется и резолвер (горячий путь), и маршрут настроек — там же, где экран
 *  показывает владельцу, что именно сейчас в силе. */
export interface GeminiModelSettings {
  geminiModel?: string | null;
  geminiLiteModel?: string | null;
  geminiFallbackModels?: string[] | null;
  geminiTranscribeModels?: string[] | null;
  geminiImageModel?: string | null;
}

/**
 * Какие модели в силе — ЧИСТАЯ функция, один источник правды.
 *
 * Отдельно от запроса к базе нарочно: то же правило нужно маршруту настроек, чтобы
 * показать владельцу действующее значение, и подсчитать его там заново значило бы
 * завести второе место, где живёт порядок источников. Разойдясь однажды, экран начал
 * бы показывать не то, чем на самом деле работает бот, — а это хуже отсутствия экрана.
 */
export function effectiveGeminiModels(
  settings: GeminiModelSettings | null
): Omit<GeminiRuntime, "keys" | "explicitCaching"> {
  return {
    model: firstFilled(settings?.geminiModel, GEMINI_MODEL),
    fallbackModels: firstFilledList(settings?.geminiFallbackModels, GEMINI_FALLBACK_MODELS),
    transcribeModels: firstFilledList(settings?.geminiTranscribeModels, GEMINI_TRANSCRIBE_MODELS),
    imageModel: firstFilled(settings?.geminiImageModel, GEMINI_IMAGE_MODEL),
    // Без дефолта в коде намеренно: пустая строка здесь значит «ступени нет»,
    // и перебор просто начнётся с обычной модели (см. callGemini).
    liteModel: firstFilled(settings?.geminiLiteModel, process.env.GEMINI_LITE_MODEL),
  };
}

/**
 * ПРО КАКИЕ ИМЕНА УЖЕ СКАЗАНО — чтобы сказать один раз, а не на каждый ход диалога.
 * Как и остальные подобные флаги (thinkingConfigRejected, rejectedKeysReported в
 * geminiClient.ts), живёт в памяти процесса: после смены имени и перезапуска отчёт
 * должен начаться с чистого листа. Процессов два (api и worker) — каждый скажет
 * своё, дедупликация logSystemError сведёт это к одной строке в журнале.
 */
const modelNamesReported = new Set<string>();

/**
 * ОТДЕЛЬНЫЙ НАБОР ДЛЯ ПРЕДУПРЕЖДЕНИЯ «ГОЛОСУ НУЖНА PRO-МОДЕЛЬ» (24.09.2026).
 *
 * НЕ modelNamesReported — то множество гасит ЛЮБОЕ повторное упоминание имени
 * модели (retired/unknown), а значит, если имя уже отчиталось по ОДНОЙ причине,
 * вторая (эта) причина для того же имени никогда не всплывёт: цикл ниже пропускает
 * `model` целиком на первом же совпадении в modelNamesReported. Свой набор — своя
 * дедупликация, ровно одна запись на имя за жизнь процесса, но независимо от
 * остальных предупреждений.
 */
const transcribeQualityWarned = new Set<string>();

/**
 * ПРОВЕРКА ИМЁН МОДЕЛЕЙ НА ВХОДЕ (30.08.2026).
 *
 * Опечатка в поле Настроек и модель, закрытая Google, ведут себя одинаково: HTTP 404
 * на КАЖДЫЙ вызов, который перебор молча вытягивает на резервной модели. В этом
 * проекте такое уже проживало два месяца незамеченным (gemini-2.5-flash, 02.08.2026).
 *
 * Поэтому имена сверяются со списком проверенных (geminiTransport.ts) в тот момент,
 * когда их впервые спросили, — то есть на первом же вызове ИИ после старта процесса.
 * Ничего не блокируется: список в коде устаревает быстрее, чем выходят модели, и
 * запретить незнакомое имя значило бы однажды не пустить владельца на новую модель.
 * Пишется РОВНО ОДНА строка на имя за жизнь процесса.
 *
 * Вызывается сама из resolveGeminiRuntime, но экспортирована нарочно: точку входа
 * (index.ts) стоит попросить дёрнуть её на старте — тогда кривое имя видно ещё до
 * первого клиента, а не после него.
 */
export function checkGeminiModelNames(models: Omit<GeminiRuntime, "keys" | "explicitCaching">): void {
  const named: [string, string][] = [
    ["основная модель", models.model],
    ...models.fallbackModels.map((m): [string, string] => ["резервная модель", m]),
    ...models.transcribeModels.map((m): [string, string] => ["модель расшифровки голосовых", m]),
    ["модель рисования", models.imageModel],
    ["дешёвая ступень", models.liteModel],
  ];
  for (const [role, model] of named) {
    if (!model || modelNamesReported.has(model)) continue;
    modelNamesReported.add(model);
    const retired = retiredGeminiModelReason(model);
    if (retired) {
      void logSystemError(
        "ai",
        `ТРЕВОГА: в настройках задана МЁРТВАЯ модель Gemini «${model}» (${role}) — ${retired}. ` +
          `Каждый вызов к ней вернёт HTTP 404, и запрос молча вытянет резервная модель — медленнее и дороже. ` +
          `Чинится без выката кода: Настройки → ИИ или переменная GEMINI_MODEL в .env.production, затем перезапуск api и worker.`
      );
      continue;
    }
    if (!isKnownGeminiModel(model)) {
      void logSystemError(
        "ai",
        `Имя модели Gemini «${model}» (${role}) нет в списке проверенных живым запросом (ai/geminiTransport.ts). ` +
          `Либо это опечатка — и тогда КАЖДЫЙ вызов вернёт 404, а бот тихо перейдёт на резерв, — ` +
          `либо модель новее списка в коде. Проверить один раз стоит: сверить с ai.google.dev/gemini-api/docs/models.`
      );
    }
  }

  /**
   * ГОЛОСУ НУЖНА PRO-МОДЕЛЬ, А НЕ ОБЫЧНАЯ ДИАЛОГОВАЯ (24.09.2026, ПРЕДУПРЕЖДЕНИЕ,
   * НЕ ЗАПРЕТ — как и всё в этой функции).
   *
   * ЗАЧЕМ. Решение владельца 19.08.2026: обычная диалоговая модель (Flash) не
   * разбирает голосовые на таджикском надёжно — путала продиктованный по цифрам
   * номер телефона, карточки не объединялись (см. докстринг ai/transcribe.ts).
   * Именно поэтому дорогая pro-модель поставлена первой в цепочке расшифровки, а
   * geminiTranscribeModels — ОТДЕЛЬНОЕ поле от geminiModel/geminiFallbackModels.
   * Но поле — обычный текст: ничто не мешает владельцу (или скрипту миграции
   * настроек) вписать туда то же имя, что и в основную модель, или имя ступени
   * flash/lite — опечатка тут не даст 404, она просто тихо вернёт ту самую беду,
   * которую 19.08 уже лечили, и заметить её нечем, кроме как перечитать код.
   *
   * ПОЧЕМУ ПО ИМЕНИ, А НЕ СПИСКОМ pro-МОДЕЛЕЙ. Список pro-моделей устареет
   * быстрее, чем код: проще и надёжнее проверить, не похожа ли модель НА ДЕШЁВУЮ
   * (совпадает с основной/резервной ИЛИ содержит «flash»/«lite» в имени), чем
   * держать актуальный перечень «хороших» имён.
   */
  const cheapDialogModels = new Set([models.model, ...models.fallbackModels].filter(Boolean));
  for (const model of models.transcribeModels) {
    if (!model || transcribeQualityWarned.has(model)) continue;
    const looksLikeCheapModel = cheapDialogModels.has(model) || /flash|lite/i.test(model);
    if (!looksLikeCheapModel) continue;
    transcribeQualityWarned.add(model);
    void logSystemError(
      "ai",
      `Модель расшифровки голосовых «${model}» совпадает с основной/резервной дешёвой моделью либо похожа по имени ` +
        `на flash/lite. Для голосовых на таджикском нужна pro-модель — обычная диалоговая путает продиктованные по ` +
        `цифрам номера телефонов (решение владельца 19.08.2026). Это предупреждение, не запрет: проверить стоит в ` +
        `Настройках → ИИ → модель расшифровки голосовых.`
    );
  }
}

export async function resolveGeminiRuntime(): Promise<GeminiRuntime> {
  let settings: {
    geminiApiKey: string | null;
    geminiApiKey2: string | null;
    geminiApiKeysExtra: string[];
    geminiModel: string | null;
    geminiFallbackModels: string[];
    geminiTranscribeModels: string[];
    geminiImageModel: string | null;
    geminiLiteModel: string | null;
    geminiExplicitCachingEnabled: boolean;
  } | null = null;
  try {
    settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        geminiApiKey: true,
        geminiApiKey2: true,
        geminiApiKeysExtra: true,
        geminiModel: true,
        geminiFallbackModels: true,
        geminiTranscribeModels: true,
        geminiImageModel: true,
        geminiLiteModel: true,
        geminiExplicitCachingEnabled: true,
      },
    });
  } catch {
    // База недоступна — ИИ обязан продолжать работать на том, что есть в окружении.
    // Это не редкость на старте контейнера и во время миграций.
  }

  const candidates: (string | null | undefined)[] = settings
    ? [
        decryptSecretSafe(settings.geminiApiKey) || process.env.GEMINI_API_KEY,
        decryptSecretSafe(settings.geminiApiKey2) || process.env.GEMINI_API_KEY_2,
        ...settings.geminiApiKeysExtra.map((extra) => decryptSecretSafe(extra)),
      ]
    : [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2];

  // Пустые отбрасываем, дубль пробуем один раз: один и тот же ключ, скопированный в
  // два поля, дважды перебирать незачем — это только тратит время таймаута перед тем,
  // что и так не сработает.
  const keys: string[] = [];
  for (const key of candidates) {
    if (!key || keys.includes(key)) continue;
    keys.push(key);
  }

  const models = effectiveGeminiModels(settings);
  // Сверка имён — здесь, а не у каждого вызывающего: это единственная точка, через
  // которую имена попадают в запросы, и одна строка на имя за жизнь процесса стоит
  // дешевле, чем ещё один месяц незамеченных 404 (см. checkGeminiModelNames).
  checkGeminiModelNames(models);
  // Отказ базы даёт ПРЕЖНЕЕ поведение (без кэша), а не новое — у этого признака нет
  // безопасного умолчания «включено», ровно как у promptEconomy (см. leadQualifier.ts).
  return { keys, ...models, explicitCaching: settings?.geminiExplicitCachingEnabled ?? false };
}
