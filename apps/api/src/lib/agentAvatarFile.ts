import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { uploadsDir } from "../upload.js";

/**
 * ФАЙЛ АВАТАРА СОТРУДНИКА — запись и уборка прежнего (G18, 02.10.2026).
 *
 * Два маршрута (свой аватар в Профиле и чужой у руководителя) писали файл
 * `avatar-<id>-<время>.webp` в открытую uploads и никогда не убирали прежний:
 * каждая замена оставляла на диске старое фото, доступное по старой ссылке.
 */
export async function saveAgentAvatarFile(agentId: string, image: Buffer): Promise<string> {
  const filename = `avatar-${agentId}-${Date.now()}.webp`;
  await sharp(image).resize(300, 300, { fit: "cover" }).webp({ quality: 88 }).toFile(path.join(uploadsDir, filename));
  return `/uploads/${filename}`;
}

/** Удаляет прежний файл аватара — только своего вида и только этого сотрудника. */
export async function removeAgentAvatarFile(agentId: string, url: string | null | undefined): Promise<void> {
  if (!url?.startsWith("/uploads/")) return;
  const name = path.basename(url);
  if (!new RegExp(`^avatar-${agentId}-\\d+\\.webp$`).test(name)) return;
  await fs.promises.rm(path.join(uploadsDir, name), { force: true }).catch((err) =>
    console.error(`[avatar] прежний аватар ${name} не удалён:`, err instanceof Error ? err.message : err)
  );
}
