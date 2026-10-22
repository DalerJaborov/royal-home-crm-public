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

/**
 * Список для выбора «кому передать»: те же, кто принимает лиды, от наименее к наиболее
 * загруженному; первый — выбран по умолчанию. `null`, если передавать некому.
 */
export function transferChoice(agents: McAgent[]): { label: string; options: { id: string; label: string }[]; defaultId: string } | null {
  const ready = [...agents].filter((a) => a.takesLeads !== false).sort((a, b) => a.activeLoad - b.activeLoad);
  if (!ready.length) return null;
  return {
    label: "Кому передать",
    options: ready.map((a) => ({ id: a.id, label: `${a.fullName} · ${a.activeLoad} в работе` })),
    defaultId: ready[0].id,
  };
}
