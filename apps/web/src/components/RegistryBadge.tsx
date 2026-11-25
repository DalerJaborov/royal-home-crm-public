import { REGISTRY_COLOR_LABEL, registryBriefLine, registryBriefWarning, type RegistryBrief } from "@royal-home/shared";

/**
 * Значок реестра разрешённых строек у объекта в списке (25.11.2026). Только для сотрудников: поле `registry` приходит
 * в ответе GET /properties и больше нигде. Цвет дублируется словом («Разрешение есть», «Нет разрешения»), подсказка —
 * в title и aria-label, чтобы смысл не держался на одном цвете. Нет связи у новостройки — «Реестр: проверить».
 * Реестр выключен или ещё не загружался — поле null, значка нет.
 */
const TONE: Record<RegistryBrief["status"], string> = { green: "ok", yellow: "warn", red: "crit", none: "mute" };

export function registryBadgeText(brief: RegistryBrief): string {
  if (brief.status === "none") return "Реестр: проверить";
  return REGISTRY_COLOR_LABEL[brief.status].title;
}

export function RegistryBadge({ brief }: { brief: RegistryBrief | null | undefined }) {
  if (!brief) return null;
  const warning = registryBriefWarning(brief);
  const tip = warning ? `${registryBriefLine(brief)} ${warning}` : registryBriefLine(brief);
  return (
    <span className={`chip ${TONE[brief.status]}`} title={tip} aria-label={tip} data-registry={brief.status}>
      {registryBadgeText(brief)}
    </span>
  );
}
