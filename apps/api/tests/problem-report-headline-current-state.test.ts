import { describe, expect, it } from "vitest";
import type { ProblemMetric, ProblemSection } from "@royal-home/shared";

/**
 * ЗАГОЛОВОК РАЗБОРА ПРОБЛЕМ НЕ ГОВОРИТ «ПРОБЛЕМ НЕТ», КОГДА ЕСТЬ ТЕКУЩИЕ
 * (аудит Codex 04.10.2026, ACCESS-12 = CHANNEL-NEW-20).
 *
 * Так было: общий вывод брал раздел по `total`, а `total` считает только метрики с
 * previous !== null. Показатели «на сейчас» (застряли в подготовке, объекты без
 * спроса) идут с previous = null и в total не входят: при семи застрявших объектах
 * и нулевых сравнимых показателях директор получал в уведомлении «Проблемных мест
 * за период не нашлось — ни потерянных клиентов, ни просрочек…».
 */

const { overallHeadline } = await import("../src/lib/problemReport.js");

function metric(key: string, value: number, previous: number | null): ProblemMetric {
  return { key, label: key, value, previous, href: null };
}

function section(key: ProblemSection["key"], title: string, metrics: ProblemMetric[], headline: string): ProblemSection {
  const comparable = metrics.filter((m) => m.previous !== null);
  const total = comparable.reduce((s, m) => s + m.value, 0);
  const previousTotal = comparable.reduce((s, m) => s + (m.previous ?? 0), 0);
  return { key, title, headline, total, previousTotal, direction: "same", metrics, links: [], breakdown: null };
}

const AGO = "неделей раньше";

describe("overallHeadline", () => {
  it("текущие проблемы без сравнимых потерь не маскируются под «не нашлось»", () => {
    const sections = [
      section("clients", "Клиенты", [metric("lost", 0, 0)], "Потерь нет"),
      section("agents", "Агенты", [metric("late", 0, 0)], "Просрочек нет"),
      section("calls", "Звонки", [metric("missed", 0, 0)], "Всё принято"),
      section(
        "properties",
        "Объекты",
        [metric("stuck", 7, null), metric("noDemand", 6, null)],
        "Застряли в подготовке: 7"
      ),
    ];
    const headline = overallHeadline(sections, AGO);
    expect(headline).not.toContain("не нашлось");
    expect(headline).toContain("Объекты");
    expect(headline).toContain("Застряли в подготовке: 7");
  });

  it("совсем нулевой набор по-прежнему «не нашлось»", () => {
    const sections = [
      section("clients", "Клиенты", [metric("lost", 0, 0)], "x"),
      section("properties", "Объекты", [metric("stuck", 0, null), metric("noDemand", 0, null)], "x"),
    ];
    expect(overallHeadline(sections, AGO)).toContain("не нашлось");
  });

  it("сравнимые потери по-прежнему главнее текущих", () => {
    const sections = [
      section("clients", "Клиенты", [metric("lost", 4, 2)], "x"),
      section("properties", "Объекты", [metric("stuck", 9, null)], "Застряли в подготовке: 9"),
    ];
    const headline = overallHeadline(sections, AGO);
    expect(headline).toContain("Больше всего теряем здесь: «Клиенты» — 4");
  });
});
