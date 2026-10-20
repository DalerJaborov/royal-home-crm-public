import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { canAccessAssignedAgent, requireAuth, requirePermission } from "../auth/middleware.js";
import { findAttachmentOwnerClientId, privateFilePath, privateMimeType } from "../lib/privateFiles.js";
import { prisma } from "../db.js";

/**
 * Выдача файлов, присланных клиентами в переписку (фото, голосовые).
 *
 * Отдельный маршрут, а не статика: папка `uploads` раздаётся `express.static` вообще
 * без проверок (app.ts), и это правильно для фотографий объектов — их и так видно на
 * сайте. Личная переписка — другое дело: по требованию владельца вложения открывают
 * только админ и директор, поэтому файлы лежат в закрытом хранилище вне `uploads`
 * (lib/privateFiles.ts), а сюда приходят через проверку права.
 *
 * Имя файла — не адрес: у того, кто его как-то узнал, но права не имеет, запрос
 * заканчивается 403, а не файлом.
 *
 * ВЛАДЕНИЕ ПО КЛИЕНТУ (К7, аудит безопасности 11.09.2026). Право
 * `messages.viewAttachments` само по себе открывало ВСЕ вложения переписки, а не
 * только свои — это ничего не меняло, пока право входило в пресеты только ADMIN и
 * DIRECTOR (они и так видят всех клиентов), но выдать его галочкой можно кому
 * угодно, и тогда сотрудник без `clients.viewAll` открыл бы вложение чужого
 * клиента, узнав (или подобрав из своей же переписки) имя файла. Поэтому здесь,
 * помимо права на роутер, — вторая проверка: `findAttachmentOwnerClientId`
 * находит диалог с этим файлом (своей таблицы вложений нет, ссылка живёт внутри
 * jsonb-массива реплик — см. lib/privateFiles.ts) и `canAccessAssignedAgent`
 * сверяет владельца диалога с текущим сотрудником. Владелец не установился
 * (диалог удалён, файл не из переписки) — тоже отказ, а не пропуск: неизвестное
 * не значит «моё».
 */
export const attachmentsRouter = Router();

// Право проверяется на весь роутер: забыть его в отдельном обработчике невозможно.
// Директор проходит автоматически — resolvePermissions выдаёт ему весь реестр.
attachmentsRouter.use(requireAuth, requirePermission("messages.viewAttachments"));

/**
 * Имя приходит из URL, поэтому проверяется схемой на границе, как и любой внешний
 * ввод. Настоящая защита от обхода пути — в privateFilePath (там же второй рубеж);
 * здесь мы лишь отсекаем заведомый мусор, не дотрагиваясь до файловой системы.
 */
const paramsSchema = z.object({ name: z.string().min(1).max(128) });

attachmentsRouter.get("/:name", async (req, res) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Неверное имя файла" });

  const fullPath = privateFilePath(parsed.data.name);
  // Один и тот же ответ и на «файла нет», и на «имя не похоже на наше»: перебором
  // имён нельзя выяснить даже того, что именно не так.
  if (!fullPath) return res.status(404).json({ error: "Файл не найден" });

  // Владение: право на роутер уже проверено, здесь — сверка с конкретным клиентом.
  // clients.viewAll пропускает без похода в базу (это ADMIN/DIRECTOR сегодня и
  // любой, кому право выдадут галочкой). Остальным — найти диалог по имени файла
  // и сверить его клиента с закреплённым агентом.
  if (!req.agent?.permissions.has("clients.viewAll")) {
    const ownerClientId = await findAttachmentOwnerClientId(parsed.data.name);
    const owner = ownerClientId
      ? await prisma.client.findUnique({ where: { id: ownerClientId }, select: { assignedAgentId: true } })
      : null;
    if (!owner || !canAccessAssignedAgent(req, owner.assignedAgentId)) {
      return res.status(403).json({ error: "Нет доступа к этому вложению" });
    }
  }

  // Content-Type ставим сами, по нашему же справочнику расширений: браузер должен
  // показать фото картинкой, а голосовое отдать плееру. nosniff — чтобы браузер не
  // пытался «угадать» тип и не выполнил что-нибудь как разметку.
  res.setHeader("Content-Type", privateMimeType(parsed.data.name));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  // private + no-store: файл персональный и выдан под конкретное право. Без этого
  // прокси или общий кэш (Cloudflare перед CRM) мог бы отдать фото клиента тому,
  // кому мы только что ответили 403.
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  // root + относительное имя, а не абсолютный путь целиком: пакет send проверяет
  // на «скрытый файл» КАЖДЫЙ сегмент переданного пути, включая родительские
  // каталоги. Абсолютный путь отдал бы 403 на ровном месте, окажись сервер
  // развёрнут в каталоге с точкой в имени (например, worktree под `.claude`, как
  // и было на 17.08.2026 при прогоне тестов) — root ограничивает проверку тем,
  // что лежит внутри самого приватного хранилища.
  res.sendFile(path.basename(fullPath), { root: path.dirname(fullPath), cacheControl: false, dotfiles: "deny" }, (err) => {
    if (!err) return;
    // Ошибка после начала отдачи — соединение уже наполовину записано, статус менять
    // поздно: просто закрываем и пишем в журнал, чтобы обрыв не выглядел успехом.
    console.error("[attachments] не удалось отдать файл:", err instanceof Error ? err.message : err);
    if (res.headersSent) res.end();
    else res.status(500).json({ error: "Не удалось прочитать файл" });
  });
});
