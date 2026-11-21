/**
 * Посредник между инструментом помощницы start_property_draft и мастером объекта в Telegram
 * (21.11.2026). Прямой импорт мастера из инструмента замыкал круг
 * ai/assistant.ts → tools/index.ts → инструмент → telegram/assistantPropertyDraft.ts → ai/assistant.ts.
 * Мастер записывает сюда себя при загрузке модуля; в процессе API он загружается всегда
 * (index.ts импортирует его на старте). Нет записи — инструмент честно отвечает «недоступно».
 */
export type PropertyDraftOpenResult =
  | { opened: true }
  | { opened: false; reason: "no_telegram" | "inactive" | "denied" | "unavailable"; text?: string };

export type PropertyDraftOpener = (agentId: string, details: string) => Promise<PropertyDraftOpenResult>;

let opener: PropertyDraftOpener | null = null;

export function registerPropertyDraftOpener(fn: PropertyDraftOpener): void {
  opener = fn;
}

export async function openPropertyDraft(agentId: string, details: string): Promise<PropertyDraftOpenResult> {
  return opener ? opener(agentId, details) : { opened: false, reason: "unavailable" };
}
