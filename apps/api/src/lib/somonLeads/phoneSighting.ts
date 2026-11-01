import { prisma } from "../../db.js";
import { somonPhoneHash } from "./contactIdentity.js";

/** Сколько разных объявлений с одним номером за окно считаем признаком агентства. */
export const SOMON_PHONE_AGENCY_ADVERTS = 3;
export const SOMON_SIGHTING_WINDOW_DAYS = 30;
export const SOMON_SIGHTING_RETENTION_DAYS = 180;

/** Запоминает «номер встретился в объявлении» (только ключевой хеш, номер не хранится)
 * и отвечает, превысил ли номер порог разных объявлений за окно. */
export async function recordSomonPhoneSighting(phone: string, advertId: string, now = new Date()): Promise<boolean> {
  const phoneHash = somonPhoneHash(phone);
  await prisma.somonPhoneSighting.createMany({ data: [{ phoneHash, advertId, seenAt: now }], skipDuplicates: true });
  const since = new Date(now.getTime() - SOMON_SIGHTING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const adverts = await prisma.somonPhoneSighting.count({ where: { phoneHash, seenAt: { gte: since } } });
  return adverts >= SOMON_PHONE_AGENCY_ADVERTS;
}
