import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ ПУТЕЙ В GRAPH INSTAGRAM (25.11.2026, разбор прода 24.11: мёртвый после смены пароля ключ Arvan каждый путь
 * встречал заново — ~270 строк журнала за сутки). Отказ ключа (401 / код 190) обязан идти через одну дверь
 * lib/instagramAccountAccess.ts: отметка один раз, одна тревога, дальше этот аккаунт в Meta не дёргаем.
 *
 * Тест не читает код за человека — он не даёт НОВОМУ файлу ходить в Graph Instagram молча: каждый файл, который строит
 * запрос (`instagramRequest(` / `instagramReadRequest(` / `instagramQueryTokenRequest(`), должен быть в списке ниже —
 * либо «дверь» (отказ разобран через instagramAccountAccess.ts), либо с причиной, почему нет. Появился новый —
 * проведите отказ через дверь (noteInstagramKeyRefused / instagramAccessGate) или впишите сюда с причиной.
 * Ключи «ещё не через дверь» — честный список слепых пятен, его надо сокращать, а не дописывать.
 */
const SITES: Record<string, string> = {
  "messengers/meta.ts": "дверь: callGraph (отправка, личное по комментарию, «печатает»), профиль собеседника",
  "messengers/comments.ts": "дверь: публикация комментария, разбор очереди, личное по комментарию",
  "messengers/instagramFeed.ts": "дверь: лента аккаунтов (21.11, #352)",
  "messengers/metaGraph.ts": "определение самих функций запроса",
  "lib/instagramWebhookSubscription.ts": "дверь: сторож подписки (21.11, #352)",
  "lib/metaInboxReconcile.ts": "дверь: сверка переписок (21.11, #352)",
  "lib/integrationHealth.ts": "дверь: суточная проверка ключей",
  "lib/instagramAccessProbe.ts": "дверь: проба GET /me аккаунта с отметкой (ревью #432), успех снимает отметку",
  "lib/socialPublish.ts": "дверь через lib/instagramPublisher.ts (отказ публикации → noteInstagramKeyRefused)",
  "lib/photoPosts.ts": "дверь через lib/instagramPublisher.ts",
  "lib/instagramPendingContainers.ts": "ключ берёт lib/instagramPublisher.ts; отказ проверки контейнера — ещё не через дверь (слепое пятно)",
  "lib/metaEternalTokens.ts": "выбор пути и чтение ленты: отказ разбирает вызывающий (instagramFeed → дверь)",
  "lib/instagramAppBindingProof.ts": "проверка СВЕЖЕГО ключа при подключении — метить нечего, ключ ещё не сохранён",
  "lib/tokenScopes.ts": "проверка прав ключа в Настройках по кнопке — отвечает человеку на экране",
  "lib/instagramInsights.ts": "статистика — ещё не через дверь (слепое пятно, раз в сутки)",
  "lib/postStats.ts": "статистика постов — ещё не через дверь (слепое пятно)",
  "lib/customerDmMediaContent.ts": "клиентское ядро (customer*) — по задаче 25.11 не трогали; слепое пятно",
  "lib/customerInstagramSenderRead.ts": "клиентское ядро (customer*) — по задаче 25.11 не трогали; слепое пятно",
  "lib/customerPublicPublicationSource.ts": "клиентское ядро (customer*) — по задаче 25.11 не трогали; слепое пятно",
};

/**
 * Файл сам ничего из src не импортирует, и тогда первый холодный импорт графа делает beforeAll из tests/setup.ts
 * (крючок выбора агента) — под нагрузкой это дольше его 20 секунд, и файл падал «Hook timed out» без единой проверки.
 * Тот же импорт на верхнем уровне файла (без предела крючка) делает крючок мгновенным.
 */
await import("../src/services/leads/selection.js");
await import("../src/lib/telephony/pickAgentForLeadHook.js");

const SRC = join(import.meta.dirname, "..", "src");
const CALL = /\binstagram(Request|ReadRequest|QueryTokenRequest)\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("пути в Graph Instagram — каждый учтён дверью отказа ключа", () => {
  const found = walk(SRC)
    .filter((f) => CALL.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).replace(/\\/g, "/"))
    .sort();

  it("новый файл с запросом в Graph Instagram не проходит молча", () => {
    const unknown = found.filter((f) => !(f in SITES));
    expect(unknown, `Новый путь в Graph Instagram: проведите отказ 401/190 через lib/instagramAccountAccess.ts ` +
      `или впишите файл в SITES этого теста с причиной`).toEqual([]);
  });

  it("список не врёт: каждый вписанный файл правда ходит в Graph Instagram", () => {
    const stale = Object.keys(SITES).filter((f) => !found.includes(f));
    expect(stale, "Файл больше не ходит в Graph Instagram — уберите его из SITES").toEqual([]);
  });

  it("у каждого вписанного файла есть причина", () => {
    for (const [file, why] of Object.entries(SITES)) expect(why.trim().length, file).toBeGreaterThan(10);
  });
});
