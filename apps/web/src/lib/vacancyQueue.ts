import type { RecruitmentPosition } from "@royal-home/shared";
import { ApiError } from "./apiError";
import { VACANCY_NO_POSITION, type JobApplication, type VacancyBulkResponse, type VacancyCreateInput,
  type VacancyDuplicateBody, type VacancyPriorityFilter } from "../types/vacancies";
import { candidateStudyState, candidateTitle, CANDIDATE_STAGE_LABELS } from "./vacanciesResume";
import { vacancyChannelLabel, vacancyInterviewLabel, vacancyReceivedLabel } from "./vacanciesView";

/**
 * Чистые правила ленты кандидатов (22.10.2026): бесконечная лента вместо
 * страниц, чипы фильтров, выбор для массовых действий, печать. Экран
 * (pages/Vacancies.tsx) только зовёт их — каждое правило проверяется тестом
 * без отрисовки.
 */

/** Сколько анкет догружается за раз. Сервер отдаёт по offset, сортировка
 *  стабильная (createdAt desc, id desc), поэтому соседние страницы не путаются. */
export const VACANCY_QUEUE_PAGE = 50;

/** Предел одного массового запроса на сервере. Больше — режем на части. */
export const VACANCY_BULK_MAX = 200;

/** Слово, которое надо набрать, чтобы удалить анкеты навсегда. */
export const VACANCY_DELETE_WORD = "УДАЛИТЬ";

/** Следующий offset ленты или undefined, когда догружать нечего. */
export function queueNextOffset(lastPageSize: number, lastOffset: number, total: number | undefined, pageSize = VACANCY_QUEUE_PAGE): number | undefined {
  if (lastPageSize < pageSize) return undefined;
  const next = lastOffset + pageSize;
  return total != null && next >= total ? undefined : next;
}

/** Склеить страницы ленты без повторов: пока листали, новая анкета могла
 *  сдвинуть offset, и одна и та же запись приходит на двух страницах. */
export function mergeQueuePages(pages: ReadonlyArray<{ items: JobApplication[] }> | undefined): JobApplication[] {
  const seen = new Set<string>(), out: JobApplication[] = [];
  for (const page of pages ?? []) for (const item of page.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id); out.push(item);
  }
  return out;
}

/** «Загружено 50 из 250» / «Все 12 загружены». */
export function queueLoadedNote(loaded: number, total: number | undefined): string {
  if (total == null) return `Загружено: ${loaded}`;
  if (loaded >= total) return total === 0 ? "Анкет нет" : `Все ${total} загружены`;
  return `Загружено ${loaded} из ${total}`;
}

export interface PositionChip { key: string; label: string; count?: number; closed?: boolean }

/** Чипы фильтра вакансии: «Все», каждая вакансия каталога, вакансии, которых
 *  в каталоге уже нет, но анкеты есть, и «Без вакансии». Числа — из
 *  positionCounts; у старого сервера их нет, чипы остаются без чисел. */
export function positionChips(positions: ReadonlyArray<Pick<RecruitmentPosition, "key" | "titleRu" | "isOpen">> | undefined,
  counts: Record<string, number> | undefined): PositionChip[] {
  const known = new Set((positions ?? []).map(position => position.key));
  const total = counts ? Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0) : undefined;
  const chips: PositionChip[] = [{ key: "", label: "Все", count: total }];
  for (const position of positions ?? []) chips.push({ key: position.key, label: position.titleRu, count: counts ? counts[position.key] ?? 0 : undefined, closed: !position.isOpen });
  for (const [key, count] of Object.entries(counts ?? {})) {
    if (key === VACANCY_NO_POSITION || known.has(key) || !count) continue;
    chips.push({ key, label: key, count });
  }
  chips.push({ key: VACANCY_NO_POSITION, label: "Без вакансии", count: counts ? counts[VACANCY_NO_POSITION] ?? 0 : undefined });
  return chips;
}

/** Число кандидатов вакансии для вкладки «Вакансии». */
export function positionCandidateCount(counts: Record<string, number> | undefined, key: string): number | undefined {
  return counts ? counts[key] ?? 0 : undefined;
}

export const VACANCY_PRIORITY_CHIPS: ReadonlyArray<{ value: VacancyPriorityFilter; label: string; dotClass: string }> = [
  { value: "GREEN", label: "Зелёные", dotClass: "dot ok" },
  { value: "YELLOW", label: "Жёлтые", dotClass: "dot warn" },
  { value: "RED", label: "Красные", dotClass: "dot crit" },
  { value: "NONE", label: "Без оценки", dotClass: "dot" },
];

/** Переключить анкету в выборе — новый Set, React видит изменение. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** «Выбрать все загруженные»: если все уже выбраны — снять выбор. */
export function toggleAllLoaded(selected: ReadonlySet<string>, items: ReadonlyArray<Pick<JobApplication, "id">>): Set<string> {
  const all = items.length > 0 && items.every(item => selected.has(item.id));
  return all ? new Set() : new Set(items.map(item => item.id));
}

/** Выбранные анкеты в порядке ленты — для печати и подписи на панели. */
export function selectedItems(items: JobApplication[], selected: ReadonlySet<string>): JobApplication[] {
  return items.filter(item => selected.has(item.id));
}

export function chunkIds(ids: readonly string[], size = VACANCY_BULK_MAX): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < ids.length; index += size) out.push(ids.slice(index, index + size));
  return out;
}

export function deleteWordMatches(input: string): boolean {
  return input.trim().toLocaleUpperCase("ru") === VACANCY_DELETE_WORD;
}

/** Удалять навсегда может только админ или директор (сервер проверяет сам). */
export function canDeleteCandidates(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "DIRECTOR";
}

/** Итог массового действия словами, с именами пропущенных. */
export function bulkResultText(result: VacancyBulkResponse, items: ReadonlyArray<JobApplication>): { text: string; skipped: string[] } {
  const names = new Map(items.map(item => [item.id, candidateTitle(item)]));
  const skipped = result.skipped.map(entry => `${names.get(entry.id) ?? "Анкета"}: ${entry.reason}`);
  return { text: `Готово: ${result.updated}.${skipped.length ? ` Пропущено: ${skipped.length}.` : ""}`, skipped };
}

/** Сложить итоги нескольких частей массового запроса. */
export function mergeBulkResults(results: VacancyBulkResponse[]): VacancyBulkResponse {
  return { updated: results.reduce((sum, result) => sum + (result.updated ?? 0), 0), skipped: results.flatMap(result => result.skipped ?? []) };
}

/** 409 «такой кандидат уже есть» → id существующей анкеты. */
export function duplicateCandidateId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const data = error.data as Partial<VacancyDuplicateBody> | null;
  return data && typeof data.existingId === "string" && data.existingId ? data.existingId : null;
}

export interface CandidateDraft { name: string; phone: string; positionKey: string; city: string; age: string; experience: string; note: string }
export const EMPTY_CANDIDATE_DRAFT: CandidateDraft = { name: "", phone: "", positionKey: "", city: "", age: "", experience: "", note: "" };

/** Проверка формы «+ Кандидат» до отправки; пустые поля не уходят на сервер. */
export function candidateCreateBody(draft: CandidateDraft): { body: VacancyCreateInput } | { error: string } {
  const name = draft.name.trim();
  if (!name) return { error: "Укажите имя кандидата." };
  if (!draft.positionKey) return { error: "Выберите вакансию." };
  const body: VacancyCreateInput = { name, positionKey: draft.positionKey };
  const phone = draft.phone.trim(), city = draft.city.trim(), experience = draft.experience.trim(), note = draft.note.trim();
  if (phone) {
    if (phone.replace(/\D/g, "").length < 7) return { error: "Проверьте телефон: в нём меньше семи цифр." };
    body.phone = phone;
  }
  if (draft.age.trim()) {
    const age = Number(draft.age.trim());
    if (!Number.isInteger(age) || age < 14 || age > 90) return { error: "Возраст — целое число от 14 до 90." };
    body.age = age;
  }
  if (city) body.city = city;
  if (experience) body.experience = experience;
  if (note) body.note = note;
  return { body };
}

/** Соседняя анкета по ↑/↓ в ленте. */
export function adjacentCandidateId(items: ReadonlyArray<Pick<JobApplication, "id">>, currentId: string | null | undefined, step: 1 | -1): string | null {
  if (!items.length) return null;
  const index = items.findIndex(item => item.id === currentId);
  if (index < 0) return items[0].id;
  return items[Math.min(items.length - 1, Math.max(0, index + step))].id;
}

const yesNo = (value: boolean | null | undefined) => value == null ? null : value ? "Да" : "Нет";

/** Факты анкеты для печати: только то, что известно, без «не указано» на бумаге. */
export function candidatePrintFacts(item: JobApplication): Array<{ label: string; value: string }> {
  const study = candidateStudyState(item);
  const rows: Array<[string, string | number | null | undefined]> = [
    ["Вакансия", item.positionTitle || "Без вакансии"],
    ["Этап", CANDIDATE_STAGE_LABELS[item.status]],
    ["Телефон", item.phone],
    ["Возраст", item.age],
    ["Город", item.city],
    ["Опыт", item.experience],
    ["Опыт в продажах", yesNo(item.salesExperience)],
    ["Машина", yesNo(item.hasCar)],
    ["Сильное желание работать", yesNo(item.strongMotivation)],
    ["Сейчас учится", yesNo(study)],
    ["Сейчас работает", yesNo(item.employedNow)],
    ["Образование", item.education],
    ["Языки", item.languages],
    ["Когда готов начать", item.startWhen],
    ["Достижения", item.achievements],
    ["Оценка", item.priorityReason],
    ["Собеседование", item.interviewAt ? vacancyInterviewLabel(item.interviewAt) : null],
    ["Откуда", `${vacancyChannelLabel(item.channel)} · ${vacancyReceivedLabel(item.createdAt)}`],
  ];
  return rows.filter((row): row is [string, string | number] => row[1] != null && String(row[1]).trim() !== "")
    .map(([label, value]) => ({ label, value: String(value) }));
}
