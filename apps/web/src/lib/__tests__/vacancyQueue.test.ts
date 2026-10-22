import { describe, expect, it } from "vitest";
import { ApiError } from "../apiError";
import type { JobApplication } from "../../types/vacancies";
import {
  adjacentCandidateId, bulkResultText, canDeleteCandidates, candidateCreateBody, candidatePrintFacts, chunkIds,
  deleteWordMatches, duplicateCandidateId, EMPTY_CANDIDATE_DRAFT, mergeBulkResults, positionChips, positionCandidateCount,
  queueLoadedNote, selectedItems, toggleAllLoaded, toggleSelected,
} from "../vacancyQueue";
import { contactConfirmBlocked, contactDefaultAddress, smsSegmentsLabel } from "../vacanciesContact";

const app = (patch: Partial<JobApplication> = {}) => ({ id: "a", name: "Алия", status: "NEW", channel: "MANUAL",
  createdAt: "2026-10-22T05:00:00Z", phone: null, age: null, city: null, experience: null, ...patch } as JobApplication);

describe("лента: подписи и выбор", () => {
  it("подпись загруженного", () => {
    expect(queueLoadedNote(50, 250)).toBe("Загружено 50 из 250");
    expect(queueLoadedNote(12, 12)).toBe("Все 12 загружены");
    expect(queueLoadedNote(50, undefined)).toBe("Загружено: 50");
  });
  it("галочки и «выбрать все загруженные»", () => {
    const items = [app({ id: "a" }), app({ id: "b" })];
    const one = toggleSelected(new Set(), "a");
    expect([...one]).toEqual(["a"]);
    expect([...toggleSelected(one, "a")]).toEqual([]);
    expect([...toggleAllLoaded(one, items)].sort()).toEqual(["a", "b"]);
    expect([...toggleAllLoaded(new Set(["a", "b"]), items)]).toEqual([]);
    expect(selectedItems(items, new Set(["b", "gone"])).map(item => item.id)).toEqual(["b"]);
  });
  it("↑/↓ не выходят за края", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(adjacentCandidateId(items, "a", 1)).toBe("b");
    expect(adjacentCandidateId(items, "b", 1)).toBe("b");
    expect(adjacentCandidateId(items, "a", -1)).toBe("a");
    expect(adjacentCandidateId(items, null, 1)).toBe("a");
    expect(adjacentCandidateId([], "a", 1)).toBeNull();
  });
});

describe("чипы вакансий", () => {
  const positions = [{ key: "real-estate-agent", titleRu: "Агент", isOpen: true }, { key: "smm-videographer", titleRu: "SMM", isOpen: false }];
  it("«Все», вакансии, «Без вакансии» с числами сервера", () => {
    const chips = positionChips(positions, { "real-estate-agent": 5, "__none": 300, "old-key": 2 });
    expect(chips.map(chip => [chip.key, chip.count])).toEqual([["", 307], ["real-estate-agent", 5], ["smm-videographer", 0], ["old-key", 2], ["__none", 300]]);
    expect(chips[2].closed).toBe(true);
  });
  it("старый сервер — без чисел", () => {
    expect(positionChips(positions, undefined).every(chip => chip.count === undefined)).toBe(true);
    expect(positionCandidateCount(undefined, "x")).toBeUndefined();
    expect(positionCandidateCount({}, "x")).toBe(0);
  });
});

describe("массовые действия и удаление", () => {
  it("режет больше 200 анкет на части и складывает итог", () => {
    const ids = Array.from({ length: 450 }, (_, index) => `id${index}`);
    expect(chunkIds(ids).map(part => part.length)).toEqual([200, 200, 50]);
    expect(mergeBulkResults([{ updated: 2, skipped: [] }, { updated: 1, skipped: [{ id: "x", reason: "своя вакансия" }] }]))
      .toEqual({ updated: 3, skipped: [{ id: "x", reason: "своя вакансия" }] });
  });
  it("пропущенные — по именам", () => {
    const result = bulkResultText({ updated: 1, skipped: [{ id: "a", reason: "вакансию задал бот" }] }, [app()]);
    expect(result.text).toBe("Готово: 1. Пропущено: 1.");
    expect(result.skipped).toEqual(["Алия: вакансию задал бот"]);
  });
  it("слово подтверждения и право удаления", () => {
    expect(deleteWordMatches(" удалить ")).toBe(true);
    expect(deleteWordMatches("удали")).toBe(false);
    expect(canDeleteCandidates("ADMIN")).toBe(true);
    expect(canDeleteCandidates("DIRECTOR")).toBe(true);
    expect(canDeleteCandidates("AGENT")).toBe(false);
    expect(canDeleteCandidates(undefined)).toBe(false);
  });
});

describe("+ Кандидат", () => {
  it("имя и вакансия обязательны, пустые поля не уходят", () => {
    expect(candidateCreateBody(EMPTY_CANDIDATE_DRAFT)).toEqual({ error: "Укажите имя кандидата." });
    expect(candidateCreateBody({ ...EMPTY_CANDIDATE_DRAFT, name: "Али" })).toEqual({ error: "Выберите вакансию." });
    expect(candidateCreateBody({ ...EMPTY_CANDIDATE_DRAFT, name: " Али ", positionKey: "smm-videographer", age: "25" }))
      .toEqual({ body: { name: "Али", positionKey: "smm-videographer", age: 25 } });
    expect("error" in candidateCreateBody({ ...EMPTY_CANDIDATE_DRAFT, name: "Али", positionKey: "x", age: "2.5" })).toBe(true);
    expect("error" in candidateCreateBody({ ...EMPTY_CANDIDATE_DRAFT, name: "Али", positionKey: "x", phone: "12" })).toBe(true);
  });
  it("409 даёт id существующей анкеты", () => {
    expect(duplicateCandidateId(new ApiError("dup", 409, { error: "dup", existingId: "old" }))).toBe("old");
    expect(duplicateCandidateId(new ApiError("bad", 400, { existingId: "old" }))).toBeNull();
    expect(duplicateCandidateId(new Error("x"))).toBeNull();
  });
});

describe("печать", () => {
  it("только известные факты, без «не указано»", () => {
    const facts = candidatePrintFacts(app({ phone: "+992900000000", age: 27, hasCar: true, salesExperience: false, positionTitle: null }));
    const labels = facts.map(fact => fact.label);
    expect(facts.find(fact => fact.label === "Вакансия")?.value).toBe("Без вакансии");
    expect(facts.find(fact => fact.label === "Машина")?.value).toBe("Да");
    expect(facts.find(fact => fact.label === "Опыт в продажах")?.value).toBe("Нет");
    expect(labels).not.toContain("Город");
    expect(labels).toContain("Телефон");
  });
});

describe("приглашение: адрес, SMS, повтор", () => {
  it("таджикский адрес подставляется, если сервер его прислал", () => {
    const office = { address: "ул. Рудаки 1", addressTg: "кӯч. Рӯдакӣ 1" };
    expect(contactDefaultAddress(office, "tg")).toBe("кӯч. Рӯдакӣ 1");
    expect(contactDefaultAddress(office, "ru")).toBe("ул. Рудаки 1");
    expect(contactDefaultAddress({ address: "ул. Рудаки 1" }, "tg")).toBe("ул. Рудаки 1");
  });
  it("число частей SMS — только если сервер прислал", () => {
    expect(smsSegmentsLabel({ smsSegments: 1 })).toBe("SMS: 1 часть");
    expect(smsSegmentsLabel({ smsSegments: 3 })).toBe("SMS: 3 части");
    expect(smsSegmentsLabel({ smsSegments: 5 })).toBe("SMS: 5 частей");
    expect(smsSegmentsLabel({})).toBeNull();
  });
  it("понятный 4xx не блокирует повтор, 5xx и сеть — блокируют", () => {
    expect(contactConfirmBlocked(false, null)).toBe(false);
    expect(contactConfirmBlocked(true, null)).toBe(true);
    expect(contactConfirmBlocked(false, new ApiError("Предпросмотр устарел", 409, {}))).toBe(false);
    expect(contactConfirmBlocked(false, new ApiError("boom", 502, {}))).toBe(true);
    expect(contactConfirmBlocked(false, new Error("Failed to fetch"))).toBe(true);
  });
});
