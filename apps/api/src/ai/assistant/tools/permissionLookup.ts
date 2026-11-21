import { PERMISSION_GROUPS, PERMISSIONS, isPermissionId, type PermissionId } from "@royal-home/shared";

/**
 * ПРАВО ПО ЧЕЛОВЕЧЕСКОМУ НАЗВАНИЮ — ОДНО МЕСТО ДЛЯ ПОМОЩНИЦЫ (17.11.2026).
 *
 * Журнал прода: «закрой РОПу право видеть номера клиентов» — ход кончился сбоем attempt_limit.
 * set_staff_permissions принимал только id («clients.viewPhone»), модель подставляла
 * догадки, каждая получала «Таких прав нет» без подсказки, и модель перебирала дальше.
 * Теперь инструмент принимает и id, и подпись права из реестра (packages/shared/src/permissions.ts,
 * та же, что на экране «Команда»), и бытовые слова («номера» = «телефоны», «смотреть» = «видеть»).
 * Неоднозначно (две подписи «Удалять безвозвратно» — у объектов и у клиентов) или не нашлось —
 * кандидаты списком, чтобы модель переспросила человека, а не гадала.
 */

export interface PermissionCandidate {
  id: PermissionId;
  /** Подпись с разделом: «Удалять безвозвратно (Клиенты и сделки)». */
  label: string;
}

export type PermissionMatch = { ok: true; id: PermissionId } | { ok: false; candidates: PermissionCandidate[] };

const GROUP_LABEL = new Map<string, string>(PERMISSION_GROUPS.map((g) => [g.id, g.label]));

/** Слова, которые не говорят, КАКОЕ право: служебные и глаголы «дать/забрать». */
const STOP_WORDS = new Set([
  "и", "в", "во", "на", "по", "с", "со", "к", "у", "из", "от", "для", "или", "а", "не",
  "право", "права", "прав", "правом", "доступ", "доступа", "доступом", "возможность", "разрешение",
  "его", "ее", "ему", "ей", "им", "их", "это", "этот", "эту", "свои", "своих",
  "закрой", "закрыть", "открой", "открыть", "дай", "дать", "выдай", "выдать", "сними", "снять",
  "убери", "убрать", "забери", "забрать", "отключи", "отключить", "включи", "включить",
  "разреши", "разрешить", "запрети", "запретить", "добавь", "добавить",
]);

/** Синонимы по основам (4 буквы): бытовое слово → слово подписи. */
const STEM_SYNONYMS: Record<string, string> = {
  номе: "теле", // «номера клиентов» = «телефоны клиентов»
  смот: "виде", види: "виде", увид: "виде", видн: "виде",
  влад: "собс", // «контакты владельцев» = «контакты собственников»
  стер: "удал",
};

function normalize(text: string): string {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalize(text).split(" ")) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    const stem = word.slice(0, 4);
    out.add(STEM_SYNONYMS[stem] ?? stem);
  }
  return out;
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

const CATALOG = PERMISSIONS.map((p) => {
  const group = GROUP_LABEL.get(p.group) ?? "";
  return {
    id: p.id as PermissionId,
    label: p.label,
    display: group ? `${p.label} (${group})` : p.label,
    normalized: normalize(p.label),
    normalizedWithGroup: normalize(`${p.label} ${group}`),
    stems: stems(p.label),
    groupStems: stems(group),
  };
});

const MIN_SCORE = 0.6;
const CLEAR_MARGIN = 0.15;
const MAX_CANDIDATES = 5;

/** Право по id, по подписи (с разделом или без) или по бытовым словам. */
export function resolvePermissionRef(ref: string): PermissionMatch {
  const raw = ref.trim();
  if (isPermissionId(raw)) return { ok: true, id: raw };
  const byId = CATALOG.find((p) => p.id.toLowerCase() === raw.toLowerCase());
  if (byId) return { ok: true, id: byId.id };
  const text = normalize(raw);
  if (!text) return { ok: false, candidates: [] };

  // Точная подпись: «Удалять безвозвратно» есть в двух разделах — без раздела это вопрос.
  const exactWithGroup = CATALOG.filter((p) => p.normalizedWithGroup === text);
  if (exactWithGroup.length === 1) return { ok: true, id: exactWithGroup[0].id };
  const exact = CATALOG.filter((p) => p.normalized === text);
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  if (exact.length > 1) return { ok: false, candidates: exact.map(({ id, display }) => ({ id, label: display })) };

  const query = stems(raw);
  // Подпись права целиком внутри фразы («Удалять безвозвратно клиентов»), раздел назван словами —
  // точное попадание, сильнее совпадения по основам: иначе соседняя подпись того же раздела
  // («Просить об удалении клиента») делит с ней счёт и даёт ложный вопрос (сборка 22.11.2026).
  const contained = CATALOG.filter((p) => p.normalized.includes(" ") && ` ${text} `.includes(` ${p.normalized} `));
  const containedInGroup = contained.length > 1 ? contained.filter((p) => overlap(query, p.groupStems) > 0) : contained;
  if (containedInGroup.length === 1) return { ok: true, id: containedInGroup[0].id };
  if (query.size === 0) return { ok: false, candidates: [] };
  const scored = CATALOG.map((p) => {
    const hits = overlap(query, p.stems);
    return { p, score: hits / Math.max(query.size, p.stems.size), group: overlap(query, p.groupStems) };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.group - a.group);
  const [best, second] = scored;
  if (best && best.score >= MIN_SCORE) {
    const clear = !second || best.score - second.score >= CLEAR_MARGIN || (best.score === second.score && best.group > second.group);
    if (clear) return { ok: true, id: best.p.id };
  }
  return {
    ok: false,
    candidates: scored.filter((s) => s.score >= 0.25).slice(0, MAX_CANDIDATES).map(({ p }) => ({ id: p.id, label: p.display })),
  };
}
