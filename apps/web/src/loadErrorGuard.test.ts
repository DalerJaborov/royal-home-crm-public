import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ К14 «ОШИБКА ЗАГРУЗКИ = ВЕЧНЫЙ СКЕЛЕТ» (аудит 20.11.2026): экран, который читает данные запросом,
 * обязан обработать ошибку этого запроса (`isError` / `error` / `status`) и показать понятный текст с «Повторить»
 * (общий компонент — `Rh2ErrorState` из components/rh2; в блоках главной — `RhBlockState kind="error"`).
 * Иначе при обрыве связи человек видит серые плашки без единого слова.
 *
 * Правило файловое: если файл из pages/ или components/look/ читает хотя бы один запрос данных (`useQuery`,
 * `useInfiniteQuery`, `useAccumulatedPages` или хук из hooks/, внутри которого они вызываются; хук-мутация не в счёт)
 * и НИ ОДИН из них не имеет обработки ошибки, файл красный — до исключения с причиной в EXCEPTIONS ниже.
 * Список исключений только убывает (тест ниже сверяет его с кодом).
 */
const SRC = new URL("./", import.meta.url);

function walk(dir: URL, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) walk(next, accept, out);
    else if (accept(entry.name)) out.push(fileURLToPath(next).replace(/\\/g, "/"));
  }
  return out;
}

/** Имена хуков, читающих данные: в сегменте `export … useX` есть useQuery/useInfiniteQuery/useAccumulatedPages. */
export function queryHookNames(): Set<string> {
  const names = new Set<string>(["useQuery", "useInfiniteQuery", "useAccumulatedPages"]);
  for (const file of walk(new URL("hooks/", SRC), (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))) {
    const source = readFileSync(file, "utf8");
    for (const segment of source.split(/^(?=export )/m)) {
      const name = /^export (?:default )?(?:function|const) (use[A-Za-z0-9]+)/.exec(segment)?.[1];
      if (!name) continue;
      if (/\b(useQuery|useInfiniteQuery|useAccumulatedPages)\b/.test(segment)) names.add(name);
    }
  }
  return names;
}

const ASSIGN = /const\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(use[A-Za-z0-9]+)\s*(?:<[^()]*>)?\(/g;

/** Сколько запросов данных читает файл и у скольких из них есть обработка ошибки. */
export function queryErrorHandling(source: string, hooks: Set<string>): { queries: number; handled: number } {
  let queries = 0;
  let handled = 0;
  for (const m of source.matchAll(ASSIGN)) {
    if (!hooks.has(m[2])) continue;
    queries++;
    const lhs = m[1];
    const ok = lhs.startsWith("{")
      ? /\b(isError|error|isLoadingError|status)\b/.test(lhs)
      : new RegExp("\\b" + lhs.replace(/\$/g, "\\$") + "\\s*\\??\\.(isError|error|isLoadingError|status)\\b").test(source);
    if (ok) handled++;
  }
  return { queries, handled };
}

/**
 * Файлы, где «ни один запрос не обрабатывает ошибку» — осознанно. Только с причиной.
 * Убывает: найдёт ошибку — перенести файл на `Rh2ErrorState` и удалить строку.
 */
const EXCEPTIONS: Record<string, string> = {
  "pages/Login.tsx": "useBranding — необязательный логотип и название на экране входа; без них вход работает",
  "pages/HallOfFame.tsx": "useMyProfile — только подсветка «это вы» в списке; сам рейтинг (useHallOfFame) обрабатывает ошибку",
  "pages/settings/AgencyTab.tsx": "useSettings — ошибку показывает SettingsLoadError над вкладкой; списки районов и ориентиров пусты, а не скелетом",
  "pages/settings/AutomationSwitchesSection.tsx": "useSettings — SettingsLoadError над вкладкой; раздел без настроек не рисуется",
  "pages/settings/DisciplineTab.tsx": "useSettings — SettingsLoadError над вкладкой; в форме подпись «настройки не загрузились»",
  "pages/settings/MissedCallSetting.tsx": "useSettings — SettingsLoadError над вкладкой",
  "pages/settings/MoneyTab.tsx": "useSettings — SettingsLoadError над вкладкой; useRefreshExchangeRate — действие",
  "pages/settings/SecurityAutomationSection.tsx": "useSettings — SettingsLoadError над вкладкой",
  "pages/settings/SellerAutomationSection.tsx": "useSettings — SettingsLoadError над вкладкой",
  "pages/settings/FunnelEditor.tsx": "один необязательный список аккаунтов для выбора; пусто — выбор просто не предлагается",
  "pages/settings/MessengerAccounts.tsx": "список подключённых аккаунтов в настройках: без скелета, пусто = «нет аккаунтов» (ошибку скрывает; в очереди на доработку)",
  "pages/settings/OwnerConfirmTransferSection.tsx": "справочный список последних заявок под переключателем: без скелета, пусто допустимо",
  "pages/settings/ReelsAutoBoostSection.tsx": "переключатель с запасным видом без данных: без скелета (ошибку настроек сообщает SettingsLoadError)",
  "pages/settings/SmsSection.tsx": "форма СМС рисуется и без данных (ключ формы «loading» → «configured»), скелета нет",
  "components/look/chats/RoyalInboxSwitch.tsx": "useCounters — только числа-бейджи у вкладок «Чаты/Звонки»; нет числа — нет бейджа",
  "pages/settings/WhatsAppTemplatesSection.tsx": "раздел рисуется только при подключённом WhatsApp: упавший запрос = раздела нет, серого скелета нет",
  "pages/SocialVideos.tsx": "здесь только подписи каналов (useSocialVideoChannels); сам список роликов обрабатывает ошибку (list.isError → Rh2ErrorState)",
  "components/look/home/blocks/director.tsx": "ошибку снимка пульта блоки показывают через d.isError → RhBlockState kind=\"error\"; два счётчика «на проверке» без скелета",
};

describe("сторож К14: экран с данными обрабатывает ошибку запроса", () => {
  const hooks = queryHookNames();
  const files = [
    ...walk(new URL("pages/", SRC), (n) => /\.tsx$/.test(n) && !/\.test\./.test(n)),
    ...walk(new URL("components/look/", SRC), (n) => /\.tsx$/.test(n) && !/\.test\./.test(n)),
  ];
  const rel = (file: string) => file.split("/src/")[1];

  it("хуки-чтения найдены (иначе сторож ничего не проверяет)", () => {
    expect(hooks.size).toBeGreaterThan(100);
    expect(hooks.has("useClients")).toBe(true);
    expect(hooks.has("useProperty")).toBe(true);
    // Мутации — не чтение: их ошибки показывает toast из общего MutationCache.
    expect(hooks.has("useApproveDeleteRequest")).toBe(false);
  });

  it("ни один экран не читает данные без обработки ошибки (кроме исключений с причиной)", () => {
    const bad: string[] = [];
    let readers = 0;
    for (const file of files) {
      const { queries, handled } = queryErrorHandling(readFileSync(file, "utf8"), hooks);
      if (queries === 0) continue;
      readers++;
      if (handled === 0 && !(rel(file) in EXCEPTIONS)) bad.push(`${rel(file)}: ${queries} запрос(ов), ошибка нигде не обработана`);
    }
    expect(readers).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });

  it("список исключений только убывает: каждое исключение всё ещё нужно и имеет причину", () => {
    const stale: string[] = [];
    for (const [path, reason] of Object.entries(EXCEPTIONS)) {
      expect(reason.length, path).toBeGreaterThan(15);
      const file = files.find((f) => rel(f) === path);
      // Файла нет (удалён или переименован) — строку убрать; файл уже обрабатывает ошибку — тоже убрать.
      if (!file) { stale.push(`${path}: файла нет`); continue; }
      const { queries, handled } = queryErrorHandling(readFileSync(file, "utf8"), hooks);
      if (!(queries > 0 && handled === 0)) stale.push(`${path}: ошибка уже обработана или запросов нет`);
    }
    expect(stale, "удалите эти исключения").toEqual([]);
  });

  it("сторож ловит экран без обработки ошибки (проверен поломкой)", () => {
    const silent = 'export function X() { const { data, isLoading } = useClients({}); return isLoading ? <Skeleton /> : <List items={data} />; }';
    expect(queryErrorHandling(silent, hooks)).toEqual({ queries: 1, handled: 0 });
    const withError = 'export function X() { const { data, isLoading, error, refetch } = useClients({}); return error ? <Rh2ErrorState onRetry={refetch} /> : null; }';
    expect(queryErrorHandling(withError, hooks)).toEqual({ queries: 1, handled: 1 });
    const viaObject = 'const q = useProperty(id); if (q.isError) return <Rh2ErrorState onRetry={() => q.refetch()} />;';
    expect(queryErrorHandling(viaObject, hooks)).toEqual({ queries: 1, handled: 1 });
    const mutationOnly = "const approve = useApproveDeleteRequest(); return <button onClick={() => approve.mutate()} />;";
    expect(queryErrorHandling(mutationOnly, hooks)).toEqual({ queries: 0, handled: 0 });
  });
});
