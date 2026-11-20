import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REGISTRY_COLOR_LABEL, type RegistryColor, type RegistryPropertyResponse } from "@royal-home/shared";
import { ConstructionPermitView } from "../ConstructionPermitCard";
import { applyPermitFilter, registryProjectsForMap } from "../../lib/registryMapFilter";
import type { PropertiesMapResponse } from "../../hooks/usePropertiesMap";

/**
 * Блок «Разрешение на строительство» (реестр строек, 20.11.2026): красный и жёлтый показывают предупреждение,
 * зелёный нет; мало данных у застройщика не превращается в выдуманную букву; «не найден» и подпись источника на месте.
 */
const UPDATED = "2026-11-18T10:00:00.000Z";

function response(color: RegistryColor, letter: "A" | "B" | "C" | "D" | null = "B"): RegistryPropertyResponse {
  return {
    enabled: true,
    updatedAt: UPDATED,
    link: {
      method: "AUTO",
      confidence: 92,
      distanceM: 20,
      reasons: ["Рядом"],
      project: {
        id: "p1",
        sourceId: "s1",
        title: "ЖК Дурахшон",
        customer: "Дурахшон иншоот",
        qaror: "524-2024",
        color,
        category: "residential",
        lat: 38.5,
        lng: 68.7,
        address: null,
        description: null,
        floors: 9,
        blocks: ["Блок А", "Блок Б"],
        documents: [
          { name: "Экспертиза", ready: true },
          { name: "Разрешение", ready: false },
        ],
        sourceUrl: "https://memor.pro/projects/1",
        statusChangedAt: null,
        removed: false,
        developerId: "d1",
      },
      developer: {
        id: "d1",
        name: "Дурахшон иншоот",
        rating: {
          total: letter ? 5 : 1,
          green: 3,
          yellow: 1,
          red: 1,
          staleRed: 0,
          sinceYear: 2020,
          score: letter ? 72 : null,
          letter,
          reasons: ["Проектов в реестре: 5."],
        },
      },
    },
    suggestions: [],
    notFound: false, notLoaded: false,
    noPoint: false,
  };
}

const render = (data: RegistryPropertyResponse) => renderToString(<ConstructionPermitView data={data} onUnlink={() => {}} />);

describe("блок «Разрешение на строительство»", () => {
  it("красный: подпись статуса и предупреждение из общих подписей, документы и этажность", () => {
    const html = render(response("red"));
    expect(html).toContain(REGISTRY_COLOR_LABEL.red.title);
    expect(html).toContain('data-testid="permit-warning"');
    expect(html).toContain("Реестр отмечает проект красным");
    expect(html).toContain("Блок А, Блок Б");
    expect(html).toContain("✓ Экспертиза");
    expect(html).toContain("Нет: Разрешение");
    expect(html).toContain("Почему такая оценка");
    expect(html).toContain('href="https://memor.pro/projects/1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("жёлтый: предупреждение есть", () => {
    const html = render(response("yellow"));
    expect(html).toContain(REGISTRY_COLOR_LABEL.yellow.title);
    expect(html).toContain('data-testid="permit-warning"');
  });

  it("зелёный: предупреждения нет", () => {
    const html = render(response("green"));
    expect(html).toContain(REGISTRY_COLOR_LABEL.green.title);
    expect(html).not.toContain('data-testid="permit-warning"');
  });

  it("у застройщика нет буквы: «Мало данных», без балла", () => {
    const html = render(response("green", null));
    expect(html).toContain("Мало данных");
    expect(html).not.toContain("Оценка ");
  });

  it("с буквой: оценка и балл", () => {
    expect(render(response("green", "B"))).toContain("Оценка B, 72 из 100");
  });

  it("в реестре не найден: подсказка про документы у застройщика", () => {
    const html = render({ enabled: true, updatedAt: UPDATED, link: null, suggestions: [], notFound: true, notLoaded: false, noPoint: false });
    expect(html).toContain("В реестре не найден");
    expect(html).toContain("запросить документы");
  });

  it("нет точки на карте: честная строка", () => {
    const html = render({ enabled: true, updatedAt: UPDATED, link: null, suggestions: [], notFound: false, notLoaded: false, noPoint: true });
    expect(html).toContain("У объекта нет точки на карте");
  });

  it("предложения: «Это он» и «Не он», не больше трёх", () => {
    const base = response("green");
    const one = { project: base.link!.project, developer: base.link!.developer, confidence: 60, distanceM: 120, reasons: [] };
    const html = render({
      enabled: true,
      updatedAt: UPDATED,
      link: null,
      suggestions: [one, { ...one, project: { ...one.project, id: "p2" } }, { ...one, project: { ...one.project, id: "p3" } }, { ...one, project: { ...one.project, id: "p4" } }],
      notFound: false, notLoaded: false,
      noPoint: false,
    });
    expect(html).toContain("Это он");
    expect(html).toContain("Не он");
    expect(html.match(/data-testid="permit-suggestion"/g)).toHaveLength(3);
  });

  it("подпись источника есть всегда, дата по Душанбе", () => {
    const html = render(response("green"));
    expect(html).toContain('data-testid="permit-source"');
    expect(html).toContain("По данным реестра");
    expect(html).toContain("18.11.2026");
  });

  it("рубильник выключен: блока нет вовсе", () => {
    expect(render({ enabled: false, updatedAt: null, link: null, suggestions: [], notFound: false, notLoaded: false, noPoint: false })).toBe("");
  });
});

describe("фильтр «Разрешение» на карте", () => {
  const prop = (id: string, clusterId: string, price: number, currency = "TJS") => ({
    id, shortId: 1, title: id, lat: 38.5, lng: 68.7, price, currency, pricePerSqmTjs: 1000, rooms: 2,
    buildingId: null, clusterId, clusterName: clusterId, intakeAgentId: null, placeDescription: "", coverPhotoUrl: null,
  });
  const data: PropertiesMapResponse = {
    properties: [prop("a", "c1", 500), prop("b", "c1", 300), prop("c", "c2", 100, "USD")],
    clusters: [
      { id: "c1", kind: "district", name: "Сино", lat: 1, lng: 1, count: 2, minPrice: 300, avgPricePerSqm: 1000 },
      { id: "c2", kind: "district", name: "Фирдавси", lat: 1, lng: 1, count: 1, minPrice: 1000, avgPricePerSqm: 1000 },
    ],
    buildings: [],
    priceScale: null,
    bounds: null,
    total: 3,
    withoutPoint: 0,
  };
  const colors: Record<string, RegistryColor> = { a: "green", b: "red" };

  it("all не трогает набор", () => {
    expect(applyPermitFilter(data, colors, "all", 10)).toBe(data);
  });

  it("фильтр скрывает объекты без связи и пересчитывает плашки", () => {
    const out = applyPermitFilter(data, colors, "green", 10);
    expect(out.properties.map((p) => p.id)).toEqual(["a"]);
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]).toMatchObject({ id: "c1", count: 1, minPrice: 500 });
    expect(out.total).toBe(1);
  });

  it("слой реестра: только жилые и по цвету", () => {
    const projects = [
      { id: "1", lat: 0, lng: 0, color: "green" as const, title: "", customer: "", category: "residential", letter: null, developerId: "d" },
      { id: "2", lat: 0, lng: 0, color: "red" as const, title: "", customer: "", category: "residential", letter: null, developerId: "d" },
      { id: "3", lat: 0, lng: 0, color: "green" as const, title: "", customer: "", category: "educational", letter: null, developerId: "d" },
    ];
    expect(registryProjectsForMap(projects, "all").map((p) => p.id)).toEqual(["1", "2"]);
    expect(registryProjectsForMap(projects, "red").map((p) => p.id)).toEqual(["2"]);
  });

  it("реестр ещё не загружен: так и пишем, а не «не найден»", () => {
    const html = render({ enabled: true, updatedAt: null, link: null, suggestions: [], notFound: false, notLoaded: true, noPoint: false });
    expect(html).toContain("ещё не загружен");
    expect(html).not.toContain("не найден");
  });
  it("у вторички без совпадений блока нет вовсе", () => {
    expect(render({ enabled: true, updatedAt: UPDATED, link: null, suggestions: [], notFound: false, notLoaded: false, noPoint: false })).toBe("");
  });
});
