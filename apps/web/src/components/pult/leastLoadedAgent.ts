import type { McAgent } from "../../hooks/useMissionControl";

/**
 * Кому пульт предлагает «Передать» (глубокая проверка 02.10.2026, F2): наименее
 * загруженный из тех, кто СЕЙЧАС принимает лиды. Замороженный агент или агент
 * на паузе приёма приходит с takesLeads=false — у него нагрузка 0, и без этого
 * фильтра пульт отдавал лид именно ему. Нет поля (старый ответ сервера) —
 * считаем, что принимает.
 */
export function pickLeastLoadedAgent(agents: McAgent[]): McAgent | null {
  return [...agents].filter((a) => a.takesLeads !== false).sort((a, b) => a.activeLoad - b.activeLoad)[0] ?? null;
}
