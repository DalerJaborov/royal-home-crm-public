import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { autoLinkProperty, toMatchInput } from "./link.js";
import { loadRegistrySettings } from "./sync.js";

/**
 * Автосвязь сразу при создании и правке объекта (21.11.2026), не дожидаясь недельного забора. Фоновый вызов: не роняет сохранение.
 * Ничего не делает, если рубильник выключен, у объекта нет точки или связь уже есть; сомнительное оставляет человеку.
 */
export async function autoLinkPropertyById(propertyId: string): Promise<void> {
  try {
    if (!(await loadRegistrySettings()).enabled) return;
    const p = await prisma.property.findFirst({
      where: { id: propertyId, deletedAt: null, lat: { not: null }, lng: { not: null } },
      select: { id: true, lat: true, lng: true, address: true, title: true, description: true, condition: true },
    });
    if (p) await autoLinkProperty(toMatchInput(p));
  } catch (err) {
    void logSystemError("api", `Реестр строек: автосвязь объекта ${propertyId} не удалась: ${err instanceof Error ? err.message : String(err)}`);
  }
}
