import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ К14 «ОШИБКА ЗАГРУЗКИ = ВЕЧНЫЙ СКЕЛЕТ» (аудит 20.11.2026, ужесточён по ревью #346).
 *
 * ЧАСТЬ 1. КАЖДЫЙ запрос данных на экране (не «хотя бы один в файле») обязан обработать ошибку: `isError` / `error` /
 * `status` результата или общие `loadView` / `blockState` / `Rh2LoadProblem` (components/rh2/Rh2ErrorState). Читаются
 * запросы из pages/ и components/ целиком (в том числе mobile, rh2, clean, look): `useQuery`, `useInfiniteQuery`,
 * `useQueries`, `useAccumulatedPages`, хуки из hooks/ и хуки, объявленные прямо в файле экрана. Хук-мутация не в счёт.
 * Накопленный долг до 21.11.2026 — в `loadErrorGuard.baseline.json` (ключ «файл::запрос»): список ТОЛЬКО УБЫВАЕТ, новый
 * запрос без обработки ошибки красный. Осознанные исключения с причиной — REASONED ниже.
 *
 * ЧАСТЬ 2. На экранах нового вида (components/look/** и перечисленные страницы) ошибка запроса НЕ прячет данные:
 * `isError` без «данных нет» (`isError && !data`) или без общей функции — красное. Есть данные — их не стираем при
 * фоновой ошибке обновления; «нет связи» и «не удалось» показывает только `loadView` (она сама смотрит на «данных нет»).
 */
const SRC = new URL("./", import.meta.url);
const BASELINE_URL = new URL("./loadErrorGuard.baseline.json", import.meta.url);

function walk(dir: URL, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) walk(next, accept, out);
    else if (accept(entry.name)) out.push(fileURLToPath(next).replace(/\\/g, "/"));
  }
  return out;
}

const READ_CALL = /\b(useQuery|useInfiniteQuery|useQueries|useAccumulatedPages)\b/;

/** Имена хуков-чтения: из hooks/ и объявленные в любом файле (в сегменте есть useQuery и т. п.). Мутации не попадают. */
export function queryHookNames(): Set<string> {
  const names = new Set<string>(["useQuery", "useInfiniteQuery", "useQueries", "useAccumulatedPages"]);
  for (const file of walk(SRC, (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))) {
    const source = readFileSync(file, "utf8");
    for (const segment of source.split(/^(?=export |function |const use)/m)) {
      const name = /^(?:export (?:default )?)?(?:function|const) (use[A-Za-z0-9]+)/.exec(segment)?.[1];
      if (name && READ_CALL.test(segment)) names.add(name);
    }
  }
  return names;
}

const ASSIGN = /const\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(use[A-Za-z0-9]+)\s*(?:<[^()]*>)?\(/g;
/** Поля результата запроса: если они в деструктуризации, это один запрос, а не «обёртка, вернувшая несколько». */
const RESULT_KEYS = /\b(data|isLoading|isPending|isError|error|status|refetch|isFetching|fetchStatus|dataUpdatedAt|failureCount|isSuccess|fetchNextPage|hasNextPage|isFetchingNextPage|isLoadingError|isRefetching)\b/;
const esc = (name: string) => name.replace(/\$/g, "\\$");

function viaHelper(source: string, name: string): boolean {
  return new RegExp(`\\b(loadView|blockState)\\(\\s*${esc(name)}\\b`).test(source) || new RegExp(`Rh2LoadProblem[^>]*query=\\{${esc(name)}\\}`).test(source);
}
function handledVar(source: string, name: string): boolean {
  return new RegExp(`\\b${esc(name)}\\??\\.(isError|error|isLoadingError|status)\\b`).test(source) || viaHelper(source, name);
}

export type QueryRead = { key: string; handled: boolean };

/** Все запросы данных файла и есть ли у каждого обработка ошибки. Ключ — «запрос = хук» (нормализован, с номером при повторе). */
export function queryReads(source: string, hooks: Set<string>): QueryRead[] {
  const out: QueryRead[] = [];
  const seen = new Map<string, number>();
  // Хук, объявленный в этом же файле, сам читает запрос и сам обрабатывает его ошибку (isError / loadView / blockState внутри).
  const localHandled = new Set<string>();
  for (const segment of source.split(/^(?=export |function |const use)/m)) {
    const name = /^(?:export (?:default )?)?(?:function|const) (use[A-Za-z0-9]+)/.exec(segment)?.[1];
    if (name && READ_CALL.test(segment) && /\b(isError|isLoadingError|loadView|blockState)\b|\.error\b/.test(segment)) localHandled.add(name);
  }
  for (const m of source.matchAll(ASSIGN)) {
    if (!hooks.has(m[2])) continue;
    const lhs = m[1].replace(/\s+/g, " ");
    let handled: boolean;
    if (localHandled.has(m[2])) handled = true;
    else if (lhs.startsWith("{")) {
      if (RESULT_KEYS.test(lhs)) handled = /\b(isError|error|isLoadingError|status)\b/.test(lhs);
      else {
        const names = lhs.slice(1, -1).split(",").map((part) => part.trim().split(":").pop()!.trim()).filter(Boolean);
        handled = names.some((name) => handledVar(source, name));
      }
    } else handled = handledVar(source, lhs);
    const base = `${lhs}=${m[2]}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: n === 1 ? base : `${base}#${n}`, handled });
  }
  return out;
}

/**
 * Файлы, где «запрос без обработки ошибки» — осознанно. Только с причиной; убывает (тест ниже сверяет с кодом).
 */
const REASONED: Record<string, string> = {
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
  "pages/settings/OwnerConfirmTransferSection.tsx": "справочный список последних заявок под переключателем: без скелета, пусто допустимо",
  "pages/settings/ReelsAutoBoostSection.tsx": "переключатель с запасным видом без данных: без скелета (ошибку настроек сообщает SettingsLoadError)",
  "pages/settings/SmsSection.tsx": "форма СМС рисуется и без данных (ключ формы «loading» → «configured»), скелета нет",
  "components/look/chats/RoyalInboxSwitch.tsx": "useCounters — только числа-бейджи у вкладок «Чаты/Звонки»; нет числа — нет бейджа",
  "pages/settings/WhatsAppTemplatesSection.tsx": "раздел рисуется только при подключённом WhatsApp: упавший запрос = раздела нет, серого скелета нет",
  "pages/SocialVideos.tsx": "здесь только подписи каналов (useSocialVideoChannels); сам список роликов обрабатывает ошибку (list.isError → Rh2ErrorState)",
  "components/look/home/blocks/director.tsx": "ошибку снимка пульта блоки показывают через blockState(d) / loadView(d); два счётчика «на проверке» без скелета",
};

const baseline: Set<string> = new Set(existsSync(BASELINE_URL) ? (JSON.parse(readFileSync(BASELINE_URL, "utf8")) as string[]) : []);

const rel = (file: string) => file.split("/src/")[1];
const screens = walk(SRC, (n) => /\.tsx$/.test(n) && !/\.test\./.test(n)).filter((f) => /^(pages|components)\//.test(rel(f)));

describe("сторож К14, часть 1: каждый запрос данных обрабатывает ошибку", () => {
  const hooks = queryHookNames();

  it("хуки-чтения найдены (иначе сторож ничего не проверяет)", () => {
    expect(hooks.size).toBeGreaterThan(100);
    expect(hooks.has("useClients")).toBe(true);
    expect(hooks.has("useProperty")).toBe(true);
    expect(hooks.has("useQueries")).toBe(true);
    // Мутации — не чтение: их ошибки показывает toast из общего MutationCache.
    expect(hooks.has("useApproveDeleteRequest")).toBe(false);
  });

  const current = new Map<string, boolean>();
  let readers = 0;
  for (const file of screens) {
    for (const read of queryReads(readFileSync(file, "utf8"), hooks)) {
      readers++;
      current.set(`${rel(file)}::${read.key}`, read.handled);
    }
  }

  it("новый запрос без обработки ошибки — красное (кроме долга в baseline и исключений с причиной)", () => {
    expect(readers).toBeGreaterThan(300);
    if (process.env.UPDATE_LOAD_ERROR_BASELINE === "1") {
      const debt = [...current].filter(([key, ok]) => !ok && !(key.split("::")[0] in REASONED)).map(([key]) => key).sort();
      writeFileSync(BASELINE_URL, JSON.stringify(debt, null, 2) + "\n");
      return;
    }
    const bad = [...current].filter(([key, ok]) => !ok && !baseline.has(key) && !(key.split("::")[0] in REASONED)).map(([key]) => key);
    expect(bad, "запрос без обработки ошибки: добавьте isError/loadView или (с причиной) REASONED").toEqual([]);
  });

  it("долг только убывает: запись в baseline либо всё ещё без обработки, либо удалена", () => {
    const stale = [...baseline].filter((key) => current.get(key) !== false);
    expect(stale, "ошибка уже обработана или запроса нет: удалите строки из loadErrorGuard.baseline.json").toEqual([]);
  });

  it("исключения с причиной всё ещё нужны", () => {
    const stale: string[] = [];
    for (const [path, reason] of Object.entries(REASONED)) {
      expect(reason.length, path).toBeGreaterThan(15);
      const keys = [...current].filter(([key]) => key.startsWith(path + "::"));
      if (keys.length === 0) stale.push(`${path}: файла или запросов нет`);
      else if (!keys.some(([, ok]) => !ok)) stale.push(`${path}: ошибка уже обработана везде`);
    }
    expect(stale, "удалите эти исключения").toEqual([]);
  });

  it("сторож ловит запрос без обработки ошибки (проверен поломкой)", () => {
    const silent = "export function X() { const { data, isLoading } = useClients({}); return isLoading ? <Skeleton /> : <List items={data} />; }";
    expect(queryReads(silent, hooks)).toEqual([{ key: "{ data, isLoading }=useClients", handled: false }]);
    const withError = "const { data, isLoading, error, refetch } = useClients({}); return error ? <Rh2ErrorState onRetry={refetch} /> : null;";
    expect(queryReads(withError, hooks).map((r) => r.handled)).toEqual([true]);
    const viaObject = "const q = useProperty(id); if (q.isError) return <Rh2ErrorState onRetry={() => q.refetch()} />;";
    expect(queryReads(viaObject, hooks).map((r) => r.handled)).toEqual([true]);
    const viaHelperSrc = "const q = useProperty(id); const state = blockState(q); return state;";
    expect(queryReads(viaHelperSrc, hooks).map((r) => r.handled)).toEqual([true]);
    const mutationOnly = "const approve = useApproveDeleteRequest(); return <button onClick={() => approve.mutate()} />;";
    expect(queryReads(mutationOnly, hooks)).toEqual([]);
    // Каждый запрос, а не «хотя бы один»: второй без обработки красный, даже когда первый в порядке.
    const two = "const a = useClients({}); const b = useProperty(id); if (a.isError) return null; return b.data;";
    expect(queryReads(two, hooks).map((r) => r.handled)).toEqual([true, false]);
    // Запрос, объявленный хуком прямо в файле экрана, и useQueries — тоже запросы.
    const local = "function useRows() { return useQuery({ queryKey: ['x'], queryFn }); }\nconst rows = useRows();";
    const withLocal = new Set([...hooks, "useRows"]);
    expect(queryReads(local, withLocal).map((r) => r.handled)).toEqual([false]);
    // …а если сам хук обрабатывает ошибку (blockState внутри), его вызов считается обработанным.
    const localOk = "function useRows() { const q = useQuery({ queryKey: ['x'], queryFn }); return { state: blockState(q) }; }\nconst rows = useRows();";
    expect(queryReads(localOk, withLocal).map((r) => r.handled)).toEqual([true, true]);
    expect(queryReads("const results = useQueries({ queries: [] });", hooks).map((r) => r.handled)).toEqual([false]);
  });
});

/** Названия, под которыми `isError` запроса читается в файле: `q.isError`, `isError`, `isError: alias`. */
function errorNames(source: string, hooks: Set<string>): RegExp[] {
  const names: RegExp[] = [];
  for (const m of source.matchAll(ASSIGN)) {
    if (!hooks.has(m[2])) continue;
    const lhs = m[1];
    if (lhs.startsWith("{")) {
      const found = /\bisError(?:\s*:\s*([A-Za-z_$][\w$]*))?/.exec(lhs);
      if (found) names.push(new RegExp(`(?<![.\\w$])${esc(found[1] ?? "isError")}\\b`));
    } else names.push(new RegExp(`\\b${esc(lhs)}\\??\\.isError\\b`));
  }
  return names;
}

/**
 * Строки, где ошибка запроса читается мимо общей функции и без «данных нет»: такая проверка прячет уже загруженные
 * данные при фоновой ошибке. Разрешено: через `loadView(` / `blockState(` / `Rh2LoadProblem`, `alert={…}` на плитке
 * (подсветка, данные не прячет), `isError && !…` (явное «данных нет»), саму деструктуризацию.
 */
export function dataHidingErrorLines(source: string, hooks: Set<string>): string[] {
  const names = errorNames(source, hooks);
  if (names.length === 0) return [];
  const bad: string[] = [];
  source.split("\n").forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
    if (!names.some((re) => re.test(line))) return;
    if (/loadView\(|blockState\(|Rh2LoadProblem|alert=/.test(line)) return;
    if (/=\s*use[A-Za-z0-9]+/.test(line)) return;
    if (/^\s*isError(\s*:\s*[\w$]+)?,?\s*$/.test(line)) return;
    if (/\b(isError|[A-Za-z_$][\w$]*Error)\s*&&\s*!/.test(line)) return;
    bad.push(`${index + 1}: ${line.trim().slice(0, 140)}`);
  });
  return bad;
}

/** Страницы нового вида, чья ошибка читается руками (остальное нового вида — components/look/**). */
const HIDING_PAGES = ["pages/Clients.tsx", "pages/ClientDetail.tsx", "pages/Properties.tsx", "pages/PropertyForm.tsx", "pages/AiLearning.tsx", "pages/settings/MessengerAccounts.tsx"];

describe("сторож К14, часть 2: ошибка запроса не прячет загруженные данные на экранах нового вида", () => {
  const hooks = queryHookNames();
  const inScope = screens.filter((f) => rel(f).startsWith("components/look/") || HIDING_PAGES.includes(rel(f)));

  it("экраны нового вида найдены", () => {
    expect(inScope.length).toBeGreaterThan(40);
    for (const page of HIDING_PAGES) expect(inScope.some((f) => rel(f) === page), page).toBe(true);
  });

  it("isError без «данных нет» или без общей функции — красное", () => {
    const bad: string[] = [];
    for (const file of inScope) for (const line of dataHidingErrorLines(readFileSync(file, "utf8"), hooks)) bad.push(`${rel(file)}:${line}`);
    expect(bad, "используйте blockState(query) / loadView(query) или `isError && !data`").toEqual([]);
  });

  it("сторож ловит проверку ошибки, прячущую данные (проверен поломкой)", () => {
    const hides = "const q = useClients({});\nreturn q.isError ? <RhBlockState kind=\"error\" /> : <List items={q.data} />;";
    expect(dataHidingErrorLines(hides, hooks)).toHaveLength(1);
    const hidesDestructured = "const { data, isError } = useClients({});\nreturn isError ? <Err /> : <List items={data} />;";
    expect(dataHidingErrorLines(hidesDestructured, hooks)).toHaveLength(1);
    const ok1 = "const q = useClients({});\nconst state = blockState(q);\nreturn state ?? <List items={q.data} />;";
    expect(dataHidingErrorLines(ok1, hooks)).toEqual([]);
    const ok2 = "const q = useClients({});\nif (q.isError && !q.data) return <Err />;";
    expect(dataHidingErrorLines(ok2, hooks)).toEqual([]);
    const ok3 = "const { data, isError } = useClients({});\nreturn <RhTile alert={isError} />;";
    expect(dataHidingErrorLines(ok3, hooks)).toEqual([]);
  });
});
