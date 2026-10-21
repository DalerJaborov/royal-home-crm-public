import { describe, expect, it } from "vitest";
import { recruitmentPositionInputSchema, recruitmentPositionSchema } from "@royal-home/shared";
import { createRecruitmentCatalogFixture } from "../../../tests/fixtures/recruitment-catalog";

describe("vacancies browser catalog fixture", () => {
  it("provides full shared catalog and template contracts for the real settings form", () => {
    const catalog = createRecruitmentCatalogFixture();
    expect(catalog.positions.every(item => recruitmentPositionSchema.safeParse(item).success)).toBe(true);
    for (const { key, ...template } of catalog.templates) {
      expect(key).toBeTruthy();
      expect(recruitmentPositionInputSchema.safeParse(template).success).toBe(true);
    }
    expect(catalog.request("/vacancies/positions/templates", "GET", null)?.body).toEqual({ items: catalog.templates });
    expect(catalog.request("/vacancies/positions", "GET", null)?.body).toEqual({ items: catalog.positions });
  });

  it("saves edits and templates with revision checks and isolated data per browser", () => {
    const catalog = createRecruitmentCatalogFixture();
    const { key, revision, ...position } = catalog.positions[0];
    const update = { ...position, titleRu: "Обновлённая тестовая вакансия", expectedRevision: revision };
    expect(catalog.request(`/vacancies/positions/${key}`, "PUT", update)?.status).toBe(200);
    expect(catalog.positions[0]).toMatchObject({ titleRu: update.titleRu, revision: 2 });
    expect(catalog.request(`/vacancies/positions/${key}`, "PUT", update)?.status).toBe(409);
    const { key: templateKey, ...template } = catalog.templates[0];
    expect(catalog.request(`/vacancies/positions/${templateKey}`, "PUT", { ...template, expectedRevision: 0 })?.status).toBe(200);
    expect(catalog.positions[1]).toMatchObject({ key: templateKey, revision: 1, isOpen: false });
    expect(createRecruitmentCatalogFixture().positions).toHaveLength(1);
  });

  it("rejects malformed updates without changing the catalog", () => {
    const catalog = createRecruitmentCatalogFixture();
    expect(catalog.request("/vacancies/positions/smm", "PUT", { titleRu: "" })?.status).toBe(400);
    expect(catalog.positions[0].revision).toBe(1);
    expect(catalog.request("/vacancies/positions/recovery", "POST", {})).toBeNull();
  });
});
