import { ShareButton } from "../ShareButton";
import { formatMoney } from "../../lib/format";
import type { Property } from "../../types";

/**
 * «Поделиться ссылкой» на объект — ОДНО место на все экраны (17.11.2026, аудит
 * F1-2). До этого текст ссылки (название, цена, район) был набран дважды в
 * PropertyDetail (шторка «Ещё» и блок «Сайт royalhome.tj»), а на телефоне
 * агента (LegacyAgentPropertyView) кнопки не было вовсе: агент на показе не мог
 * скинуть клиенту ссылку на сайт.
 *
 * Только у опубликованного объекта: у остальных страницы на сайте нет
 * (`siteUrl` приходит null) — кнопка не рисуется. Права отдельного не требует:
 * ссылка публичная. Точного адреса в тексте нет и не должно быть.
 */
export function PropertyShareLink({
  property,
  className,
  label,
}: {
  property: Pick<Property, "title" | "price" | "currency" | "district" | "siteUrl">;
  className?: string;
  label?: string;
}) {
  if (!property.siteUrl) return null;
  return (
    <ShareButton
      className={className}
      label={label}
      title={property.title}
      text={`${property.title}, ${formatMoney(property.price, property.currency)}, ${property.district?.name ?? ""}`}
      url={property.siteUrl}
    />
  );
}
