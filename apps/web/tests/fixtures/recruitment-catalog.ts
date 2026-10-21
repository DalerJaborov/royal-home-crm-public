import {
  DEFAULT_RECRUITMENT_SCREENING_RULES,
  recruitmentPositionKeySchema,
  recruitmentPositionUpdateSchema,
  type RecruitmentPosition,
  type RecruitmentPositionInput,
} from "@royal-home/shared";

export function createRecruitmentCatalogFixture() {
  const positions: RecruitmentPosition[] = [{
    key: "smm", titleRu: "SMM-специалист / видеограф", titleTg: "Мутахассиси SMM / видеограф",
    detailsRu: "Тестовые условия: съёмка и монтаж коротких видео, работа в офисе.",
    detailsTg: "Шартҳои санҷишӣ: наворбардорӣ ва таҳрири видео, кор дар офис.",
    isOpen: true, keywords: ["контент"], postCodes: [], revision: 1,
    screeningRules: structuredClone(DEFAULT_RECRUITMENT_SCREENING_RULES),
  }];
  const templates: Array<RecruitmentPositionInput & { key: string }> = [{
    key: "test-assistant", titleRu: "Тестовый помощник", titleTg: "Ёрдамчии санҷишӣ",
    detailsRu: "Тестовая заготовка вакансии для проверки формы.",
    detailsTg: "Намунаи санҷишии ҷойи кор барои санҷиши шакл.",
    isOpen: false, keywords: ["помощник"], postCodes: [],
    screeningRules: structuredClone(DEFAULT_RECRUITMENT_SCREENING_RULES),
  }];

  function request(path: string, method: string, body: unknown) {
    if (method === "GET" && path === "/vacancies/positions") return { status: 200, body: { items: positions } };
    if (method === "GET" && path === "/vacancies/positions/templates") return { status: 200, body: { items: templates } };
    if (method !== "PUT" || !/^\/vacancies\/positions\/[^/]+$/.test(path)) return null;
    const key = recruitmentPositionKeySchema.safeParse(path.slice(path.lastIndexOf("/") + 1));
    const parsed = recruitmentPositionUpdateSchema.safeParse(body);
    if (!key.success || !parsed.success) return { status: 400, body: { error: "Проверьте данные тестовой вакансии" } };
    const index = positions.findIndex(position => position.key === key.data);
    const current = index < 0 ? null : positions[index];
    if (parsed.data.expectedRevision !== (current?.revision ?? 0)) {
      return { status: 409, body: { error: "Вакансия уже изменилась. Обновите карточку." } };
    }
    const { expectedRevision, ...input } = parsed.data;
    const saved: RecruitmentPosition = { ...input, key: key.data, revision: expectedRevision + 1 };
    if (index < 0) positions.push(saved); else positions[index] = saved;
    return { status: 200, body: { items: positions } };
  }
  return { positions, templates, request };
}
