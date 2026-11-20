import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { backups, oversight, security, stuckWork } from "../../../../tests/e2e/helpers/controlFixtures";

/**
 * «НОВЫЙ ВИД» ЭКРАНОВ КОНТРОЛЯ (пачка control, 19.11.2026): вид другой — данные те же.
 *
 * Один и тот же ответ сервера рисуется в прежнем виде и в новом, и ТЕКСТ страницы
 * (всё, что читает человек и экранный чтец) обязан совпасть до символа: новый вид не
 * может потерять ни флаг антифрода, ни причину, ни счётчик, ни кнопку и не может
 * дописать своё. Меняются только классы, метка раздела и значки (svg без текста).
 * Без признака вида — ни одного следа нового вида в разметке.
 */
const state = vi.hoisted(() => ({ royal: false, investigations: true, summary: undefined as unknown, empty: false }));
vi.mock("../../../hooks/useRoyalLook", () => ({ useRoyalLook: () => state.royal }));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/permissions")>()),
  useCan: () => () => true,
  useCanViewInvestigations: () => state.investigations,
}));
vi.mock("../../../store/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../store/auth")>();
  return { ...real, useAuthStore: (pick: (s: unknown) => unknown) => pick({ agent: { id: "ag-1", role: "ADMIN" } }) };
});
vi.mock("../../../hooks/useCounters", () => ({ useCounters: () => ({ data: undefined }) }));
vi.mock("../../SectionTabs", () => ({ TeamTabs: () => <nav>Вкладки команды</nav>, SettingsTabs: () => <nav>Вкладки здоровья</nav> }));
vi.mock("../../TranscriptView", () => ({ TranscriptView: () => <div>Расшифровка</div> }));

const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
vi.mock("../../../hooks/useOversight", () => ({
  useOversightSummary: () => ok(state.summary === undefined ? oversight.summary : state.summary),
  useOverdueTasks: () => ok(oversight.overdueTasks),
  useNoContactClients: () => ok(oversight.noContactClients),
  useLeadTransfers: () => ok(oversight.leadTransfers),
  useSilentAfterShowing: () => ok(oversight.silentAfterShowing),
  useRefusedHighScore: () => ok(oversight.refusedHighScore),
  useTransferPairs: () => ok(state.empty ? { ...oversight.transferPairs, pairs: [] } : oversight.transferPairs),
  useSellerPropertyMissing: () => ok(oversight.sellerPropertyMissing),
  useEndlessNegotiations: () => ok(oversight.endlessNegotiations),
  useAgentLossSeries: () => ok(oversight.agentLossSeries),
  useShowingSurveyCalls: () => ok(state.empty ? { ...oversight.showingSurveyCalls, items: [], total: 0 } : oversight.showingSurveyCalls),
  useShowingSurveyCall: () => ({ data: undefined, isLoading: false }),
  useShowingSurveyRecordingUrl: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useSecurity", () => ({
  useLostClients: () => ok(security.lostClients),
  useLostProperties: () => ok({ ...security.lostClients, items: [], total: 0 }),
  useSecuritySummary: () => ok(security.summary),
}));
vi.mock("../../security/InvestigationCasesPanel", () => ({ InvestigationCasesPanel: () => <section>Дела и доказательства</section> }));
vi.mock("../../security/WeeklyOperationalPreviewPanel", () => ({ WeeklyOperationalPreviewPanel: () => <details>Недельный обзор</details> }));
vi.mock("../../../hooks/useBackups", () => ({ useBackups: () => ({ data: backups, isLoading: false, isError: false }) }));
vi.mock("../../../pages/settings/SystemTab", () => ({
  SystemHealthSection: () => <div>Журнал ошибок</div>,
  StuckConversationsSection: () => <div>Зависшие диалоги</div>,
  AuditLogSection: () => <div>Журнал действий</div>,
}));
vi.mock("../../../pages/settings/BotTab", () => ({
  BotQuestionsSection: () => <div>Бот спрашивает</div>,
  BotLessonsSection: () => <div>Правила бота</div>,
  LostClientsSection: () => <div>Куда уходят</div>,
}));
vi.mock("../../BotAuditSection", () => ({ BotAuditSection: () => <div>Аудит</div> }));
vi.mock("../../DistillNowButton", () => ({ DistillNowButton: () => <button type="button">Разобрать сейчас</button> }));
vi.mock("../../BotTrainingPanels", () => ({
  GuardStatsPanel: () => <div>Стражи</div>, PendingCasesPanel: () => <div>Ждут</div>,
  SavedTrainingSamplesSection: () => <div>Образцы</div>, TrainingSession: () => <div>Тренировка</div>,
}));
vi.mock("../../trainer/BotTrainer", () => ({ BotTrainer: () => <div>Тренажёр</div> }));
vi.mock("../../../hooks/useBotLearning", () => ({
  useBotLearning: () => ok({ questionsGroupsTotal: 2, questionsTotal: 5, promptCount: 40, rulesGroupsTotal: 52, activeCount: 48, promptLimit: 40, rulesTotal: 60 }),
}));
vi.mock("../../../hooks/useBotAudit", () => ({ useBotAuditList: () => ok({ unresolvedTotal: 3 }) }));
vi.mock("../../../hooks/useSettings", () => ({ useSettings: () => ({ data: { botTrainingScreenEnabled: true }, isLoading: false }) }));

import { Oversight } from "../../../pages/Oversight";
import { SecurityCenter } from "../../../pages/SecurityCenter";
import { Backups } from "../../../pages/Backups";
import { Health } from "../../../pages/Health";
import { StuckWork } from "../../../pages/StuckWork";
import { AiLearning } from "../../../pages/AiLearning";
import { ControlRoot } from "./ControlRoot";
import { controlTile } from "./controlTileIcon";

void stuckWork;
const SCREENS = [
  { name: "Контроль руководителя", url: "/oversight", el: <Oversight /> },
  { name: "Служба безопасности", url: "/security", el: <SecurityCenter /> },
  { name: "Резервные копии", url: "/backups", el: <Backups /> },
  { name: "Здоровье системы", url: "/health", el: <Health /> },
  { name: "Что не доехало", url: "/stuck-work", el: <StuckWork /> },
  { name: "Обучение бота (правила)", url: "/ai-learning?tab=rules", el: <AiLearning /> },
];
const render = (url: string, el: ReactElement) => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}>{el}</MemoryRouter>);
/** Что читает человек: текст без разметки (значки — svg без текста — сюда не попадают). */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

beforeEach(() => Object.assign(state, { royal: false, investigations: true, summary: undefined, empty: false }));

describe("экраны контроля в новом виде: тот же текст, другие классы", () => {
  it.each(SCREENS)("$name: весь текст прежнего вида на месте, лишнего нет", ({ url, el }) => {
    state.royal = false;
    const legacy = render(url, el);
    state.royal = true;
    const royal = render(url, el);
    expect(text(legacy).length).toBeGreaterThan(40);
    expect(text(royal)).toBe(text(legacy));
    // без признака — ни следа нового вида; с признаком — корень помечен разделом
    expect(legacy).not.toMatch(/data-ry-section|ry-control|ry-tile|ry-circle/);
    expect(royal).toMatch(/^<div class="rh2 screens ry-control" data-ry-section="control">/);
  });

  it("«Контроль руководителя»: все срезы антифрода на месте в обоих видах (проверено поломкой: без среза — красный)", () => {
    state.royal = true;
    const html = text(render("/oversight", <Oversight />));
    for (const slice of ["Просроченные задачи", "Пропали после показа", "Продавец без объекта", "Переговоры по кругу",
      "Отказались, хотя клиент был хороший", "Звонки-опросы после показа", "Агент теряет клиентов подряд", "Передачи между агентами", "Кто кому чаще передаёт клиентов"]) {
      expect(html, slice).toContain(slice);
    }
    // красные флаги звонка-опроса — подписью, не только цветом
    expect(html).toContain("просил личный номер в обход CRM");
    expect(html).toContain("сделка мимо агентства");
    expect(html).toContain("руководству отправлено");
  });

  it("срочные плитки — пламя и класс ry-tile-crit; спокойные — свой значок (смысл не только оттенком)", () => {
    state.royal = true;
    const html = render("/oversight", <Oversight />);
    // в фикстуре срочные ровно две: просроченные задачи (3) и «не связывались» (2)
    expect(html.match(/class="tile ry-tile-crit"/g)).toHaveLength(2);
    expect(controlTile("clock", true).className).toBe("ry-tile-crit");
    expect(controlTile("clock", false).className).toBeUndefined();
    expect(controlTile("clock", true).icon).toBe(controlTile("eye", true).icon);
    expect(controlTile("clock").icon).not.toBe(controlTile("eye").icon);
  });

  it("смысл строк сохранён: срочная строка остаётся .quiet.crit, внимание — .quiet.warn, вердикты СБ — свои метки", () => {
    for (const royal of [false, true]) {
      state.royal = royal;
      const html = render("/oversight", <Oversight />);
      expect(html.match(/class="quiet crit"/g)?.length, `crit, royal=${royal}`).toBe(4);
      expect(html.match(/class="quiet warn"/g)?.length, `warn, royal=${royal}`).toBe(4);
      const sb = render("/security", <SecurityCenter />);
      expect(sb).toContain('class="chip crit"');
      expect(sb).toContain('class="chip ok"');
      expect(sb).toContain('class="chip warn"');
    }
  });

  it("резервные копии и «Что не доехало»: сбой — красный круг с пламенем, норма — зелёный (только в новом виде)", () => {
    state.royal = true;
    const html = render("/backups", <Backups />);
    expect(html.match(/data-tone="crit"/g)).toHaveLength(2); // сбой оффсайта: последний прогон + история
    expect(html.match(/data-tone="ok"/g)).toHaveLength(4);
    state.royal = false;
    expect(render("/backups", <Backups />)).not.toContain("data-tone");
  });

  it("ControlRoot без признака — прежний корень до байта", () => {
    expect(renderToStaticMarkup(<ControlRoot royal={false}><i /></ControlRoot>)).toBe('<div class="rh2 screens"><i></i></div>');
    expect(renderToStaticMarkup(<ControlRoot royal><i /></ControlRoot>)).toBe('<div class="rh2 screens ry-control" data-ry-section="control"><i></i></div>');
  });

  it("срочность плитки — одна переменная на подпись и на круг (ревью PR 305; проверено поломкой)", () => {
    const checked: string[] = [];
    for (const page of ["Oversight", "SecurityCenter", "Health", "AiLearning"]) {
      const src = readFileSync(new URL(`../../../pages/${page}.tsx`, import.meta.url), "utf8");
      for (const m of src.matchAll(/controlTile\("[\w-]+", ([^)]+)\)/g)) {
        expect(m[1], `${page}: второй аргумент controlTile — имя переменной, не выражение`).toMatch(/^\w+$/);
        expect(src, `${page}: та же переменная в critical=`).toContain(`critical={${m[1]}}`);
        checked.push(`${page}:${m[1]}`);
      }
    }
    expect(checked.length).toBe(9);
    // поломка: условие записано дважды — сторож краснеет
    const dup = 'controlTile("clock", summary.overdue > 0)';
    expect(/^\w+$/.test(/controlTile\("[\w-]+", ([^)]+)\)/.exec(dup)![1])).toBe(false);
  });

  it("«Контроль руководителя» (разделы директора 20.11): пустые срезы — одной строкой «всё спокойно», нули — серые плитки", () => {
    // Всё по нулям, кроме «не связывались»: в новом виде остаётся один срез и одна строка спокойствия.
    state.summary = { ...oversight.summary, overdueTasks: 0, recentTransfers: 0, silentAfterShowing: 0, refusedHighScore: 0,
      sellerPropertyMissingWarn: 0, sellerPropertyMissingCritical: 0, endlessNegotiations: 0, agentLossSeries: 0 };
    state.empty = true;
    state.royal = true;
    const html = render("/oversight", <Oversight />);
    const royalText = text(html);
    expect(royalText).toContain("Без замечаний: просроченных задач нет, после показов никто не пропал");
    // журнал передач — за всё время: не прячется, а окно названо прямо
    expect(royalText).toContain("за 30 дней передач клиентов не было");
    expect(royalText).toContain("Передачи между агентами");
    // строка «без замечаний» стоит ПОД срезами с проблемами
    expect(royalText.indexOf("Без замечаний")).toBeGreaterThan(royalText.indexOf("Не связывались С клиентом"));
    expect(royalText).toContain("Не связывались");
    for (const gone of ["Просроченные задачи Обещанный", "Переговоры по кругу С продавцом", "Звонки-опросы после показа", "Кто кому чаще передаёт клиентов"]) {
      expect(royalText, gone).not.toContain(gone);
    }
    // семь нулевых плиток серые, срочная «не связывались» — красная
    expect(html.match(/class="tile ry-tile-calm"/g)).toHaveLength(7);
    expect(html.match(/class="tile ry-tile-crit"/g)).toHaveLength(1);
    // дни без контакта у строки
    expect(royalText).toMatch(/\d+ (день|дня|дней) без контакта|меньше дня без контакта/);
    // прежний вид — все срезы на месте, строки «всё спокойно» нет
    state.royal = false;
    const legacy = text(render("/oversight", <Oversight />));
    expect(legacy).not.toContain("Без замечаний");
    expect(legacy).toContain("Звонки-опросы после показа");
    // сводка не пришла — сворачивать нечем, сбой не выглядит спокойствием
    state.royal = true;
    state.summary = null;
    expect(text(render("/oversight", <Oversight />))).not.toContain("Без замечаний");
  });

  it("нет числа у среза — «неизвестно», а не «спокойно»: срез показан, NaN на плитке нет (ревью PR 336)", () => {
    const { sellerPropertyMissingWarn: _w, sellerPropertyMissingCritical: _c, ...rest } = oversight.summary;
    void _w; void _c;
    state.summary = { ...rest, overdueTasks: 0 };
    state.royal = true;
    const html = text(render("/oversight", <Oversight />));
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("у всех продавцов есть объект");
    expect(html).not.toContain("undefined");
    expect(html).toContain("Продавец без объекта 2 карточки Принят");
    // ноль — свёрнут в строку
    expect(html).toContain("Без замечаний: просроченных задач нет");
  });
});
