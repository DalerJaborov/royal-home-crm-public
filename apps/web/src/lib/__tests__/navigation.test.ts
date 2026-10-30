import { describe, expect, it } from "vitest";
import { resolvePermissions, type PermissionId, type Role } from "@royal-home/shared";
import { buildNavigation, type NavInputs } from "../navigation";

/**
 * МЕНЮ ПЛОСКОЕ — ДЕВЯТЬ СТРОК (вариант «плоские восемь», решение владельца
 * 15.09.2026, `docs/archive/menu-wave2-brief-15-09.md`).
 *
 * Тест переписан целиком: до 15.09 он закреплял семь складок и их состав, а
 * складок больше нет — группа стала ОДНОЙ строкой, соседи по смыслу живут
 * вкладками на экране (components/SectionTabs.tsx). Проверяем ровно то, что
 * ломается тихо и чего не видно ни сборке, ни типам:
 *   1. состав девяти строк и то, что он одинаков по смыслу у всех ролей;
 *   2. СУММУ значков — непрочитанное не имеет права спрятаться за свёрнутым;
 *   3. справочные счётчики (`badgeQuiet`) в сумму не входят;
 *   4. вход в группу ведёт в первый ДОСТУПНЫЙ пункт, а не в жёсткий адрес;
 *   5. группа без единого доступного пункта не рисуется вовсе.
 */

function makeCan(role: Role): (permission: PermissionId) => boolean {
  const granted = resolvePermissions(role, null);
  return (permission: PermissionId) => granted.has(permission);
}

function makeInputs(role: Role): NavInputs {
  return {
    role,
    can: makeCan(role),
    counters: { clients: 3, deals: 2, calendar: 1, messages: 5, comments: 0, calls: 4, vacancies: 1 },
    siteNotifications: { total: 0 },
    oversightSummary: { overdueTasks: 2 },
    marketingSummary: { overdue: 1 },
    editorsLoad: { sharedQueue: { inEditing: 3, overdue: 1 } },
    deleteRequests: { items: [] },
    propertyDeleteRequests: { items: [] },
    settings: { botTrainingScreenEnabled: true },
  };
}

function routes(items: { to: string }[]): string[] {
  return items.map((i) => i.to);
}

describe("buildNavigation — плоское меню из девяти строк", () => {
  it.each(["HEAD_OF_SALES", "MANAGER", "AGENT", "SECURITY", "SHAREHOLDER"] as Role[])("%s does not gain marketing queue access from object moderation", role => {
    const nav = buildNavigation({ ...makeInputs(role), can: () => true });
    expect(routes(nav.all)).not.toContain("/pipeline");
    expect(routes(nav.all)).not.toContain("/marketing");
  });
  it.each(["DIRECTOR", "ADMIN", "MARKETING", "EDITOR"] as Role[])("%s retains server-supported preparation queue", role => {
    expect(routes(buildNavigation(makeInputs(role)).all)).toContain("/pipeline");
  });
  it("DIRECTOR: десять строк в заданном порядке", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    expect(nav.main.map((i) => i.label)).toEqual([
      "Главная",
      "Календарь",
      "Обращения",
      "Клиенты",
      "Сделки",
      "Объекты",
      "Команда",
      "Деньги",
      "Маркетинг",
      "Настройки",
    ]);
  });

  it("складок и системного хвоста больше нет: рейка рисует только main", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    expect(nav.sections).toEqual([]);
    expect(nav.system).toEqual([]);
  });

  it("значок строки — сумма значков внутри группы", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    // Обращения = Сообщения 5 + Комментарии 0 + Звонки 4.
    expect(nav.main.find((i) => i.label === "Обращения")?.badge).toBe(9);
  });

  it("справочный счётчик в сумму НЕ входит (кандидаты в «Вакансиях» не горят)", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    // Команда = только «Контроль руководителя» 2; вакансий 1, но они badgeQuiet.
    expect(nav.main.find((i) => i.label === "Команда")?.badge).toBe(2);
  });

  it("группа без непрочитанного идёт без значка, а не с нулём", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    expect(nav.main.find((i) => i.label === "Объекты")?.badge).toBeUndefined();
  });

  it("строка ведёт в первый ДОСТУПНЫЙ пункт группы", () => {
    const director = buildNavigation(makeInputs("DIRECTOR"));
    expect(director.main.find((i) => i.label === "Деньги")?.to).toBe("/finance");
    expect(director.main.find((i) => i.label === "Клиенты")?.to).toBe("/clients");
  });

  it("AGENT: «Сделки» — своя строка меню, а «Потерянных» (право clients.assign) нет", () => {
    // 23.09.2026: после сокращения вкладок «Клиентов» до двух «Сделки» не
    // открывались ни из меню, ни из вкладок — агенты не находили сделку.
    const nav = buildNavigation(makeInputs("AGENT"));
    const deals = nav.main.find((i) => i.label === "Сделки");
    expect(deals?.to).toBe("/deals");
    expect(routes(nav.all)).not.toContain("/lost-clients");
  });

  it("AGENT: шесть строк на виду, «Звонки» и «Команда» в нижней группе «Ещё»", () => {
    // Ревью ПК 06.10.2026 (review-pc.md §1): рейка агента не длиннее шести.
    const nav = buildNavigation(makeInputs("AGENT"));
    expect(nav.main.map((i) => i.label)).toEqual(["Главная", "Клиенты", "Объекты", "Чаты", "Календарь", "Сделки"]);
    expect(nav.main.find((i) => i.label === "Чаты")?.to).toBe("/messages");
    expect(nav.more.map((i) => i.to)).toEqual(["/calls", "/team"]);
    // Права не менялись: пункты «Ещё» по-прежнему в общем реестре (поиск, «Все разделы»).
    expect(routes(nav.all)).toEqual(expect.arrayContaining(["/calls", "/team", "/messages"]));
  });

  it("не-агенты: нижней группы «Ещё» нет, меню прежнее", () => {
    expect(buildNavigation(makeInputs("DIRECTOR")).more).toEqual([]);
    expect(buildNavigation(makeInputs("MANAGER")).more).toEqual([]);
  });

  it("AGENT: «Деньги» и «Настройки» не рисуются — ни одного доступного пункта", () => {
    const nav = buildNavigation(makeInputs("AGENT"));
    const labels = nav.main.map((i) => i.label);
    expect(labels).not.toContain("Деньги");
    expect(labels).not.toContain("Настройки");
    // Свои разделы у агента остаются.
    expect(labels).toContain("Клиенты");
    expect(labels).toContain("Объекты");
  });

  it("EDITOR: «Клиентов» нет, раздел монтажа есть и подписан «Монтаж» (право aiListing)", () => {
    const nav = buildNavigation(makeInputs("EDITOR"));
    const labels = nav.main.map((i) => i.label);
    expect(labels).not.toContain("Клиенты");
    // Пункт ведёт на экран, который у монтажёра называется «Монтаж», — подпись та же.
    expect(labels).toContain("Монтаж");
    expect(labels).not.toContain("Маркетинг");
  });

  it("«Инсайты от ИИ» — в «Деньгах», как и вкладки на самом экране", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    expect(nav.all.find((i) => i.to === "/insights")?.group).toBe("money");
  });

  it("«всё подряд» (поиск и «Ещё») по-прежнему знает про свёрнутые разделы", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    // Пункты исчезли из рейки, но не из поиска: иначе «Телефония» стала бы
    // недостижимой для того, кто ищет её по названию.
    expect(routes(nav.all)).toContain("/telephony");
    expect(routes(nav.all)).toContain("/archive");
  });
});


describe("agent phone navigation preservation", () => {
  it("keeps Home, Clients, Chat and More around the quick-action button", () => {
    const nav = buildNavigation(makeInputs("AGENT"));
    expect(routes(nav.bottom.left)).toEqual(["/", "/clients"]);
    expect(routes(nav.bottom.right)).toEqual(["/messages", "/more"]);
    expect(nav.bottom.right[0].badge).toBe(5);
    expect(nav.more.some((item) => item.to === "/calls")).toBe(true);
    expect(nav.all.some((item) => item.to === "/properties")).toBe(true);
  });
  it("never adds chat access when the permission is absent", () => {
    const inputs = makeInputs("AGENT");
    const can = inputs.can;
    inputs.can = (permission) => permission !== "messages.view" && permission !== "messages.viewOwn" && can(permission);
    const nav = buildNavigation(inputs);
    expect(routes(nav.bottom.right)).toEqual(["/calendar", "/more"]);
  });
  it("does not change the director's existing navigation", () => {
    const nav = buildNavigation(makeInputs("DIRECTOR"));
    expect(routes(nav.bottom.right)).toEqual(["/properties", "/messages"]);
  });
});
