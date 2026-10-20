/** Поля формы, которые может предзаполнить ответ ИИ-разбора заметки. */
export interface ParsedInteractionPatch {
  type?: string;
  outcome?: string;
  notes?: string;
  nextAction?: string;
  nextActionDate?: string;
}

/**
 * Что применить к форме по ответу разбора заметки. Разбор идёт секунды, и агент
 * за это время дописывает или диктует дальше: ответ по СТАРОМУ тексту затирал
 * новый (notes и следующий шаг), и уточнение терялось до сохранения. Если текст
 * с момента отправки изменился, ответ устарел и не применяется (null): вызывающий
 * запускает разбор заново уже по свежему тексту (FORMS03).
 *
 * ИИ обучен на прежнем наборе типов и может вернуть MESSAGE/MEETING, которых в
 * списке больше нет: такой тип пропускаем, иначе select окажется пустым.
 */
export function parseResultPatch(
  sentText: string,
  currentText: string,
  interaction: {
    type: string;
    outcome?: string | null;
    notes?: string | null;
    nextAction?: string | null;
    nextActionDate?: string | null;
  },
  validTypes: readonly string[]
): ParsedInteractionPatch | null {
  if (sentText !== currentText) return null;
  const patch: ParsedInteractionPatch = {};
  if (validTypes.includes(interaction.type)) patch.type = interaction.type;
  if (interaction.outcome) patch.outcome = interaction.outcome;
  if (interaction.notes) patch.notes = interaction.notes;
  if (interaction.nextAction) patch.nextAction = interaction.nextAction;
  if (interaction.nextActionDate) patch.nextActionDate = interaction.nextActionDate;
  return patch;
}
