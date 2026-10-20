import { isPultModuleId, type PultModuleId } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * Флаги модулей пульта (docs/pult-direktora-audit-02-09-2026.md §4).
 *
 * Читаются одним findMany и живут в памяти 15 с: агрегатор опрашивается с фронта
 * каждые 15 с, и ходить в базу за флагами на каждый запрос смысла нет. У worker-
 * процесса свой экземпляр кэша — он не видит invalidate из api-процесса, но
 * ночным тикам достаточно свежести в 15 с.
 *
 * Отказ базы — fail-open: пульт остаётся целым, а не пустым. Строки с
 * незнакомыми id (модуль удалён из реестра) игнорируются.
 */
const CACHE_TTL_MS = 15_000;
const NONE: ReadonlySet<PultModuleId> = new Set();

let cached: { at: number; off: ReadonlySet<PultModuleId> } | null = null;

export async function loadDisabledPultModules(): Promise<ReadonlySet<PultModuleId>> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.off;
  try {
    const rows = await prisma.pultModule.findMany({ where: { enabled: false }, select: { id: true } });
    const off: ReadonlySet<PultModuleId> = new Set(rows.map((r) => r.id).filter(isPultModuleId));
    cached = { at: now, off };
    return off;
  } catch (err) {
    console.error("[pult-modules] флаги не прочитаны:", err instanceof Error ? err.message : err);
    return cached?.off ?? NONE;
  }
}

export function invalidatePultModuleCache(): void {
  cached = null;
}

export async function isPultModuleEnabled(id: PultModuleId): Promise<boolean> {
  return !(await loadDisabledPultModules()).has(id);
}
