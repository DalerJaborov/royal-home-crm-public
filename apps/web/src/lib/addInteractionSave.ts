import { clientUpdateSchema, geoMatchKey } from "@royal-home/shared";

/**
 * Сохранение окна «Записать разговор» (components/AddInteractionModal.tsx) —
 * глубокая проверка 02.10.2026, F4.
 *
 * Два шага: само взаимодействие и правка карточки клиента по подсказке ИИ.
 * Раньше ответ ИИ уходил в PATCH как есть: «комнат: 2.5», бюджет 0 или
 * «от» больше «до» давали 400 на втором шаге, окно оставалось открытым с
 * ошибкой, а повторное «Сохранить» заводило ВТОРОЙ такой же разговор (ключ
 * повтора запроса новый на каждый вызов — сервер повтора не узнаёт).
 */

/** Что ИИ предлагает дописать в карточку (ответ /ai/parse-note). null — «не услышал». */
export interface AiClientUpdates {
  budgetMin?: number | null;
  budgetMax?: number | null;
  desiredDistrict?: string | null;
  desiredRooms?: number | null;
  requirementsNotes?: string | null;
}

/**
 * Правка карточки из подсказки ИИ — только поля, которые примет сервер (та же
 * схема clientUpdateSchema из @royal-home/shared). Негодное поле отбрасывается,
 * а не валит весь шаг: годный бюджет не должен пропадать из-за дробных комнат.
 */
export function buildAiClientPatch(
  clientUpdates: AiClientUpdates,
  districts: { id: string; name: string }[] | undefined
): Record<string, unknown> {
  // Район из разбора — тем же ключом, что на сервере: «Шоҳмансур» и
  // «Шохмансур» один район, а не молча потерянный (29.09.2026).
  const wantedDistrict = clientUpdates.desiredDistrict ? geoMatchKey(clientUpdates.desiredDistrict) : "";
  const matchedDistrict = wantedDistrict ? districts?.find((d) => geoMatchKey(d.name) === wantedDistrict) : undefined;
  // AI возвращает JSON null для незаполненных полей — zod принимает только undefined, не null.
  const patch: Record<string, unknown> = {};
  if (clientUpdates.budgetMin != null) patch.budgetMin = clientUpdates.budgetMin;
  if (clientUpdates.budgetMax != null) patch.budgetMax = clientUpdates.budgetMax;
  if (matchedDistrict) patch.desiredDistrictId = matchedDistrict.id;
  if (clientUpdates.desiredRooms != null) patch.desiredRooms = clientUpdates.desiredRooms;
  if (clientUpdates.requirementsNotes != null) patch.requirementsNotes = clientUpdates.requirementsNotes;

  // Каждый проход убирает хотя бы одно поле, так что цикл конечен.
  for (;;) {
    const checked = clientUpdateSchema.safeParse(patch);
    if (checked.success) return patch;
    const bad = checked.error.issues.map((i) => String(i.path[0] ?? "")).filter((k) => k in patch);
    if (bad.length === 0) return {};
    for (const key of bad) delete patch[key];
  }
}

/**
 * Шаг за шагом, но повтор не заводит второе взаимодействие: после первого
 * успешного шага вызывающий отмечает его (`markSaved`) и в следующий раз
 * передаёт `alreadySaved: true` — дописывается только карточка.
 */
export async function saveInteractionWithCard(opts: {
  alreadySaved: boolean;
  saveInteraction: () => Promise<unknown>;
  markSaved: () => void;
  updateCard: (() => Promise<unknown>) | null;
}): Promise<void> {
  if (!opts.alreadySaved) {
    await opts.saveInteraction();
    opts.markSaved();
  }
  if (opts.updateCard) await opts.updateCard();
}
