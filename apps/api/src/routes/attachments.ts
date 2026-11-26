import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { loadAgentAccess, requireAuth, requirePermission } from "../auth/middleware.js";
import { findAttachmentOwnerClientId, privateFilePath, privateMimeType } from "../lib/privateFiles.js";
import { prisma } from "../db.js";
import { contactAvatarPath } from "../lib/contactAvatar.js";
import { canOpenChatAttachments, verifyAttachmentLink } from "../lib/chatAttachmentLinks.js";
import { DerivedMediaUnavailable, derivedMime, ensureDerived } from "../lib/chatMediaDerived.js";

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
    // Та же дверь, что у выдачи подписанной ссылки (lib/chatAttachmentLinks.ts).
    if (!owner || !canOpenChatAttachments(req, owner.assignedAgentId)) {
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

/**
 * ВЫДАЧА ПО ПОДПИСАННОЙ ССЫЛКЕ (25.11.2026) — `<img>`/`<video>`/`<audio>` грузят
 * файл напрямую, без заголовка Authorization. Право и владелец проверены, когда
 * ссылку выдавали вместе с перепиской (lib/messageAttachments.ts →
 * canOpenChatAttachments); здесь — только подпись и срок. Подпись привязана к
 * имени файла: подставить чужое имя под свою подпись нельзя.
 *
 * Монтируется ДО attachmentsRouter (app.ts), иначе его requireAuth перехватил бы
 * запрос. Range отдаёт сам res.sendFile (пакет send): перемотка видео и
 * голосовых, без которой Safari на iPhone видео по сети не играет вовсе.
 *
 * `v=t` — уменьшенное фото для ленты, `v=p` — версия, которую играет любой
 * браузер (lib/chatMediaDerived.ts). Вид не подписывается: это тот же файл
 * того же клиента.
 */
export const signedAttachmentsRouter = Router();

const signedQuerySchema = z.object({
  a: z.string().min(1).max(64),
  e: z.coerce.number().int().positive(),
  k: z.string().min(16).max(64),
  /** t: миниатюра фото, p: копия для браузера, a: миниатюра собеседника в списке чатов (lib/contactAvatar.ts). */
  v: z.enum(["t", "p", "a"]).optional(),
  m: z.enum(["a", "v"]).optional(),
});

/**
 * Подпись верна (имя файла, сотрудник, срок) — без похода в базу. Нужна ещё и
 * лимитеру (app.ts): он считает ТОЛЬКО запросы с неверной подписью, честные
 * (в том числе оборванные кусками Range) не трогает вовсе.
 */
export function signedAttachmentRequestValid(req: { params?: unknown; query?: unknown; path?: string }): boolean {
  let name = "";
  try {
    name = decodeURIComponent((req.path ?? "").replace(/^\//, "").split("/")[0] ?? "");
  } catch {
    return false; // битая кодировка в адресе — точно не наша ссылка
  }
  const query = signedQuerySchema.safeParse(req.query);
  return !!name && query.success && verifyAttachmentLink(name, query.data.a, query.data.e, query.data.k);
}

/** Срок кэша в браузере — до конца действия подписи, но не больше шести часов. */
function privateMaxAge(expSec: number): number {
  return Math.max(0, Math.min(6 * 60 * 60, expSec - Math.floor(Date.now() / 1000) - 60));
}

signedAttachmentsRouter.get("/:name", async (req, res) => {
  const params = paramsSchema.safeParse(req.params);
  const query = signedQuerySchema.safeParse(req.query);
  // Один ответ на «подпись не та», «срок вышел» и «имя чужое»: перебором ничего не узнать.
  if (!params.success || !query.success || !verifyAttachmentLink(params.data.name, query.data.a, query.data.e, query.data.k)) {
    return res.status(403).json({ error: "Ссылка на вложение устарела — обновите переписку" });
  }
  // Подпись выдана конкретному сотруднику: отключили учётку — ссылка гаснет сразу
  // (кэш доступа — секунды, общий с requireAuth), а не через часы до конца срока.
  const access = await loadAgentAccess(query.data.a).catch(() => null);
  // Миниатюра собеседника (v=a) открыта тем, кто видит список чатов; вложения переписки: правом на вложения.
  const isAvatar = query.data.v === "a";
  const allowed = isAvatar
    ? !!access && (access.permissions.has("messages.view") || access.permissions.has("messages.viewOwn"))
    : !!access?.permissions.has("messages.viewAttachments");
  if (!access?.isActive || !allowed) {
    return res.status(403).json({ error: "Ссылка на вложение устарела — обновите переписку" });
  }
  if (isAvatar) {
    const avatarPath = contactAvatarPath(params.data.name);
    if (!avatarPath) return res.status(404).json({ error: "Файл не найден" });
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Cache-Control", `private, max-age=${privateMaxAge(query.data.e)}`);
    return res.sendFile(path.basename(avatarPath), { root: path.dirname(avatarPath), cacheControl: false, dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: "Не удалось прочитать файл" });
    });
  }
  const fullPath = privateFilePath(params.data.name);
  if (!fullPath) return res.status(404).json({ error: "Файл не найден" });

  let servePath = fullPath;
  let mime = privateMimeType(params.data.name);
  if (query.data.v) {
    try {
      const hint = query.data.m === "a" ? "audio" : query.data.m === "v" ? "video" : undefined;
      servePath = await ensureDerived(params.data.name, query.data.v === "t" ? "thumb" : "play", hint);
      mime = derivedMime(servePath);
    } catch (err) {
      if (err instanceof DerivedMediaUnavailable && query.data.v === "t") {
        // Миниатюры нет (sharp не справился) — отдаём оригинал: фото всё равно покажется.
        servePath = fullPath;
      } else {
        const reason = err instanceof DerivedMediaUnavailable ? err.reason : "failed";
        if (reason === "preparing") {
          // Копия считается в фоне: браузер повторит через несколько секунд.
          res.setHeader("Retry-After", "5");
          res.setHeader("Cache-Control", "no-store");
          return res.status(503).json({ error: "Готовим файл для браузера", reason });
        }
        return res.status(reason === "disabled" ? 404 : 422).json({
          error: reason === "disabled" ? "Копия для браузера выключена в Настройках" : "Этот файл браузер не воспроизводит — скачайте его",
          reason,
        });
      }
    }
  }

  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  // Ссылка с подписью не должна уйти третьей стороне в заголовке Referer.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  // private — только браузер этого сотрудника, общий кэш (Cloudflare) не хранит.
  // Срок короче подписи: просроченная ссылка не отдаётся из кэша дольше, чем жила.
  res.setHeader("Cache-Control", `private, max-age=${privateMaxAge(query.data.e)}`);
  res.sendFile(path.basename(servePath), { root: path.dirname(servePath), cacheControl: false, dotfiles: "deny", acceptRanges: true }, (err) => {
    if (!err) return;
    // Обрыв соединения браузером посреди видео — обычное дело (перемотка), не ошибка.
    if ((err as NodeJS.ErrnoException).code === "ECONNABORTED" || res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json({ error: "Не удалось прочитать файл" });
  });
});
