import { z } from "zod";
import type { PultModuleId } from "./pultModules.js";

/**
 * Главный экран пульта директора — раздел 1 «Доклад ИИ» (docs/pult/01-doklad-ii.md,
 * макет docs/pult/mockups/01-doklad-ii.html): 9 областей компании, у каждой одна
 * крупная цифра, одна тихая строка и цвет; сверху — доклад в три предложения.
 *
 * Здесь — чистая сборка из ответа GET /dashboard/mission-control, без React и без
 * ИИ: доклад v1 детерминированный (спецификация §5 — «честный доклад v1 соберётся
 * только из детекторов»). Живёт в shared, чтобы тесты api проверяли ту же логику,
 * что рисует web. Правило владельца: никаких карточек-уведомлений — срочное здесь
 * тон «crit» на тихой строке, не отдельная плашка.
 */

export type PultTone = "ok" | "warn" | "crit";

/**
 * Одна строка в списке «items» зоны пульта (задача L2-T3, docs/pult/theme-2026/tasks-theme-2026.md
 * D6 — расширение mission-control деталями вместо голого count). До 5 штук на зону,
 * одним запросом с `take: 5` — см. dashboardMissionControl.ts. Опциональное поле в
 * ответе: старые клиенты, которые его не ждут, продолжают работать без изменений.
 */
export const pultZoneItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string(),
  tone: z.enum(["ok", "warn", "crit"]),
  hint: z.string(),
});
export type PultZoneItem = z.infer<typeof pultZoneItemSchema>;
export const pultZoneItemsSchema = z.array(pultZoneItemSchema).max(5);

export type PultAreaId = "clients" | "team" | "money" | "properties" | "calls" | "ads" | "bot" | "deals" | "system";

export interface PultArea {
  id: PultAreaId;
  label: string;
  /** Маршрут CRM, куда ведёт плитка. */
  href: string;
  /** Крупная цифра-суть. */
  big: string;
  /** Тихая строка под цифрой; при tone=crit рисуется красным. */
  line: string;
  tone: PultTone;
}

export interface PultReport {
  title: string;
  text: string;
}

export interface PultView {
  areas: PultArea[];
  /** Сколько областей в красном — центр кольца. */
  urgentCount: number;
  report: PultReport;
}

type Section<T> = T | { error: true };

/** Минимальный срез ответа /dashboard/mission-control, который нужен экрану. */
export interface PultSnapshot {
  seesMoney: boolean;
  modulesOff: PultModuleId[];
  hero: Section<{
    commission: { fact: number; plan: number; forecastPercent: number } | null;
    leadsToday: { count: number; deltaVsYesterday: number };
    firstResponse: { noneCountYesterday: number };
    missedCallsToday: number;
    /** items — до 5 штук, опционально (задача L2-T3): последние клиенты в активной воронке. */
    dealsInPipeline: { count: number; items?: PultZoneItem[] };
  }>;
  team?: Section<{
    agents: { pendingAccept: number; lastSeenAt?: string | null }[];
  }>;
  calls?: Section<{
    live: { incoming: unknown[]; outgoing: unknown[] };
    today: { incoming: number; missed: number; unqualified: number };
  }>;
  bot?: Section<{
    ai: { requestsToday: number; errorRatePercent: number };
    unresolvedFindings: number | null;
  }>;
  marketing?: Section<{
    instagramCommentsWaiting: number;
    funnel: { label: string; leadsToday: number; anomalyLeadsDown: boolean }[];
  }>;
  video?: Section<{ pipeline: { overdue: number } }>;
  /** items — до 5 штук, опционально (задача L2-T3): недавно добавленные объекты в продаже. */
  properties?: Section<{ available: number; newThisWeek: number; reserved: number; items?: PultZoneItem[] }>;
  system?: Section<{ crons: { healthy: boolean }[]; jobsGivenUp: number; errorsToday: number }>;
}

function ok<T>(v: Section<T> | undefined): v is T {
  return v !== undefined && !(typeof v === "object" && v !== null && (v as { error?: unknown }).error === true);
}

/** Русское склонение: plural(3, "дело", "дела", "дел") → "дела". */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function somoni(n: number): string {
  return `${Math.round(n).toLocaleString("ru-RU")} с`;
}

const WORST: Record<PultTone, number> = { ok: 0, warn: 1, crit: 2 };
function worst(...tones: PultTone[]): PultTone {
  return tones.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), "ok");
}

/**
 * @param hourDushanbe час по Душанбе 0–23 — доклад меняет тон по времени суток (спецификация §6)
 */
export function buildPultView(s: PultSnapshot, hourDushanbe: number): PultView {
  const off = new Set(s.modulesOff);
  const areas: PultArea[] = [];
  const hero = ok(s.hero) ? s.hero : null;

  // Клиенты — hero всегда есть (не модуль); тихая строка — вчерашние без касания.
  if (hero) {
    const none = hero.firstResponse.noneCountYesterday;
    areas.push({
      id: "clients",
      label: "Клиенты",
      href: "/clients",
      big: `${hero.leadsToday.count} ${plural(hero.leadsToday.count, "новый", "новых", "новых")}`,
      line: none > 0 ? `${none} ${plural(none, "клиенту", "клиентам", "клиентам")} вчера никто не ответил` : "Вчера ответили всем",
      tone: none > 0 ? "crit" : "ok",
    });
  }

  if (!off.has("team") && ok(s.team)) {
    const pending = s.team.agents.reduce((a, x) => a + x.pendingAccept, 0);
    areas.push({
      id: "team",
      label: "Команда",
      href: "/team",
      big: `${s.team.agents.length} ${plural(s.team.agents.length, "агент", "агента", "агентов")}`,
      line: pending > 0 ? `${pending} ${plural(pending, "лид ждёт", "лида ждут", "лидов ждут")} принятия` : "Все клиенты в работе",
      tone: pending > 0 ? "warn" : "ok",
    });
  }

  if (hero && s.seesMoney && hero.commission) {
    const pct = hero.commission.forecastPercent;
    areas.push({
      id: "money",
      label: "Деньги",
      href: "/finance",
      big: `${pct} % плана`,
      line: `${somoni(hero.commission.fact)} из ${somoni(hero.commission.plan)}`,
      tone: pct >= 90 ? "ok" : pct >= 70 ? "warn" : "crit",
    });
  }

  if (!off.has("properties") && ok(s.properties)) {
    const overdue = !off.has("video") && ok(s.video) ? s.video.pipeline.overdue : 0;
    areas.push({
      id: "properties",
      label: "Объекты",
      href: "/properties",
      big: `${s.properties.available} в продаже`,
      line:
        overdue > 0
          ? `${overdue} ${plural(overdue, "объект застрял", "объекта застряли", "объектов застряли")} в подготовке`
          : `${s.properties.newThisWeek} новых за неделю · ${s.properties.reserved} в резерве`,
      tone: overdue > 0 ? "crit" : "ok",
    });
  }

  if (!off.has("calls") && ok(s.calls)) {
    const live = s.calls.live.incoming.length + s.calls.live.outgoing.length;
    const missed = s.calls.today.missed;
    areas.push({
      id: "calls",
      label: "Звонки",
      href: "/telephony",
      big: `${s.calls.today.incoming} ${plural(s.calls.today.incoming, "входящий", "входящих", "входящих")}`,
      line:
        missed > 0
          ? `${missed} ${plural(missed, "пропущенный", "пропущенных", "пропущенных")} сегодня`
          : live > 0
            ? `Сейчас говорят: ${live}`
            : "Пропущенных нет",
      tone: missed > 0 ? "crit" : "ok",
    });
  }

  if (!off.has("marketing") && ok(s.marketing)) {
    const leadsToday = s.marketing.funnel.reduce((a, c) => a + c.leadsToday, 0);
    const down = s.marketing.funnel.find((c) => c.anomalyLeadsDown);
    const comments = s.marketing.instagramCommentsWaiting;
    areas.push({
      id: "ads",
      label: "Реклама",
      href: "/sources",
      big: `${leadsToday} ${plural(leadsToday, "лид", "лида", "лидов")} сегодня`,
      line: down
        ? `${down.label} даёт меньше обычного`
        : comments > 0
          ? `${comments} ${plural(comments, "комментарий ждёт", "комментария ждут", "комментариев ждут")} ответа`
          : "Каналы в норме",
      tone: down ? "warn" : comments > 0 ? "warn" : "ok",
    });
  }

  if (!off.has("bot") && ok(s.bot)) {
    const findings = s.bot.unresolvedFindings ?? 0;
    const err = s.bot.ai.errorRatePercent;
    areas.push({
      id: "bot",
      label: "Бот и переписка",
      href: "/messages",
      big: `${s.bot.ai.requestsToday} ${plural(s.bot.ai.requestsToday, "ответ", "ответа", "ответов")}`,
      line:
        err > 5
          ? `Ошибок ИИ ${err} % — выше нормы`
          : findings > 0
            ? `${findings} ${plural(findings, "замечание", "замечания", "замечаний")} по диалогам`
            : "Бот отвечает без сбоев",
      tone: err > 5 ? "crit" : findings > 0 ? "warn" : "ok",
    });
  }

  if (hero) {
    areas.push({
      id: "deals",
      label: "Сделки",
      href: "/deals",
      big: `${hero.dealsInPipeline.count} в работе`,
      line: hero.missedCallsToday > 0 ? "Смотрите пропущенные — это будущие сделки" : "Воронка движется",
      tone: "ok",
    });
  }

  if (!off.has("system") && ok(s.system)) {
    const healthy = s.system.crons.filter((c) => c.healthy).length;
    const total = s.system.crons.length;
    const bad = total - healthy;
    const errors = s.system.errorsToday;
    areas.push({
      id: "system",
      label: "Система",
      href: "/health",
      big: bad === 0 && errors === 0 ? "Без сбоев" : `${errors} ${plural(errors, "ошибка", "ошибки", "ошибок")}`,
      line:
        bad > 0
          ? `${bad} ${plural(bad, "задача молчит", "задачи молчат", "задач молчат")} · ${s.system.jobsGivenUp} упало`
          : errors > 0
            ? "Разобрать в журнале ошибок"
            : "Все проверки зелёные",
      tone: worst(bad > 0 ? "crit" : "ok", errors > 0 ? "warn" : "ok"),
    });
  }

  const urgentCount = areas.filter((a) => a.tone === "crit").length;
  return { areas, urgentCount, report: buildReport(hero, s.seesMoney, urgentCount, hourDushanbe) };
}

function buildReport(
  hero: Extract<PultSnapshot["hero"], { leadsToday: unknown }> | null,
  seesMoney: boolean,
  urgentCount: number,
  hour: number
): PultReport {
  // Имени в заголовке доклада НЕТ (09.09.2026): по имени здоровается строка
  // приветствия над докладом («Салом, Имя. Сначала это:», PultHero2026), и два
  // обращения подряд читались как сбой. Здесь остаётся только время суток.
  const title =
    hour < 11
      ? "Вот что было вчера и ночью."
      : hour < 17
        ? "Вот темп дня."
        : "Вот итог дня.";

  const parts: string[] = [];
  if (hero) {
    const n = hero.leadsToday.count;
    const d = hero.leadsToday.deltaVsYesterday;
    const cmp = d === 0 ? "как вчера" : d > 0 ? `на ${d} больше, чем вчера` : `на ${-d} меньше, чем вчера`;
    parts.push(`Сегодня ${n} ${plural(n, "новый клиент", "новых клиента", "новых клиентов")}, ${cmp}.`);
  }
  parts.push(
    urgentCount > 0
      ? `${urgentCount} ${plural(urgentCount, "дело ждёт", "дела ждут", "дел ждут")} вас: отмечены красным ниже.`
      : "Срочного ничего нет."
  );
  if (hero && seesMoney && hero.commission) {
    parts.push(`Деньги: на ${hero.commission.forecastPercent} % плана месяца.`);
  } else if (hero && hero.missedCallsToday > 0) {
    parts.push(`Пропущенных звонков сегодня: ${hero.missedCallsToday}.`);
  }
  return { title, text: parts.join(" ") };
}
