import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { narrationConfigSchema, narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import { localVideoDelete, localVideoFilePath } from "./localVideoStorage.js";
import { mixNarrationOntoMaster, type NarrationMixResult } from "./narrationMix.js";

/**
 * РОЛИК БЕЗ ГОЛОСА — «МАСТЕР» (11.11.2026, решение владельца). Новый порядок: монтажёр
 * получает озвучку только для длины и темпа и присылает ролик БЕЗ голоса (музыка и звуки
 * можно); CRM хранит его в закрытом хранилище (Property.videoMasterStorageKey) и сама
 * накладывает одобренную озвучку. Смена цены дальше обходится без монтажёра: новая
 * озвучка → перемикс из мастера → замена вышедшего ролика (narrationAutoFlow.remixFromMasters).
 *
 * Модуль не знает про очередь монтажа и публикацию (их держит lib/videoHandoff.ts), чтобы
 * приём ролика мог звать его без цикла импортов.
 */

/**
 * Решение при приёме: ролик — мастер, если монтажёру по ЭТОМУ объекту реально ушла озвучка
 * с указанием «пришлите без голоса» (план передачи несёт mixByCrm) и рубильник не выключен.
 * Объекты, где монтажёр вклеивал голос сам по прежним указаниям, так и принимаются готовыми.
 */
export async function planCrmMixOnReceive(propertyId: string): Promise<
  { mode: "CRM_MIX"; version: { id: string; revision: number; storageKey: string } } | { mode: "EDITOR_VOICE" }
> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } });
  const config = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  if (!config.success || !narrationMixByCrm(config.data)) return { mode: "EDITOR_VOICE" };
  const sent = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId, status: "SENT" }, select: { plan: true }, take: 50 });
  const told = sent.some((d) => !!d.plan && typeof d.plan === "object" && !Array.isArray(d.plan) && (d.plan as Record<string, unknown>).mixByCrm === true);
  if (!told) return { mode: "EDITOR_VOICE" };
  const version = await prisma.propertyNarrationVersion.findFirst({
    where: { propertyId, status: "READY", approvedAt: { not: null }, storageKey: { not: null } },
    orderBy: { revision: "desc" }, select: { id: true, revision: true, storageKey: true },
  });
  if (!version?.storageKey) return { mode: "EDITOR_VOICE" };
  return { mode: "CRM_MIX", version: { id: version.id, revision: version.revision, storageKey: version.storageKey } };
}

/** Ключ мастера в закрытом хранилище: в папке объекта, рядом с его озвучками (формат ключа — localVideoStorage). */
export function narrationMasterKey(propertyId: string, ext: string): string {
  const safeExt = /^\.[A-Za-z0-9]{2,5}$/.test(ext) ? ext.toLowerCase() : ".mp4";
  return `${propertyId}/${randomUUID()}${safeExt}`;
}

/** Сохранить принятый файл как мастер (копией: исходный файл остаётся у вызывающего). */
export async function storeNarrationMaster(propertyId: string, fromPath: string): Promise<string> {
  const key = narrationMasterKey(propertyId, path.extname(fromPath));
  const dest = localVideoFilePath(key);
  if (!dest) throw new Error("Некорректный ключ мастера");
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(fromPath, dest);
  return key;
}

/** Мастер + озвучка версии → готовый ролик по пути outPath. */
export async function mixFromStoredMaster(input: { masterKey: string; voiceKey: string; outPath: string }): Promise<NarrationMixResult> {
  const masterPath = localVideoFilePath(input.masterKey);
  const voicePath = localVideoFilePath(input.voiceKey);
  if (!masterPath || !voicePath || !fs.existsSync(masterPath) || !fs.existsSync(voicePath)) {
    return { ok: false, code: "FFMPEG", error: "Файл ролика без голоса или озвучки не найден на сервере." };
  }
  return mixNarrationOntoMaster({ masterPath, voicePath, outPath: input.outPath });
}

export async function dropNarrationMaster(key: string | null | undefined): Promise<void> {
  if (key) await localVideoDelete(key).catch(() => false);
}
