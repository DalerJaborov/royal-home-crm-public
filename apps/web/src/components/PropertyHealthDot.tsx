import type { PropertyHealthBrief } from "@royal-home/shared";

/**
 * Точка светофора у объекта в списке (24.09.2026). Та же оценка, что вверху
 * вкладки «Статистика» карточки. Серую («рано судить») не рисуем: точка
 * должна звать открыть объект, а про новый объект сказать пока нечего.
 */
export function PropertyHealthDot({ health }: { health: PropertyHealthBrief | undefined }) {
  if (!health || health.color === "gray") return null;
  const text = health.tip ? `${health.headline}. ${health.tip}` : health.headline;
  return <span className={`hdot ${health.color}`} role="img" aria-label={text} title={text} />;
}
