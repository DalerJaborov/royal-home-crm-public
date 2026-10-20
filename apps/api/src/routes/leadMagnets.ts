import { Router, type RequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import {
  LEAD_MAGNET_FILE_MAX_BYTES,
  LEAD_MAGNET_NAME_MAX,
  leadMagnetCampaignInputSchema,
  type LeadMagnetState,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { uploadsDir, UploadRejectedError } from "../upload.js";
import { crmPublicBase } from "../lib/crmPublicUrl.js";
import { invalidateLeadMagnetCache, rehearseCampaign } from "../lib/leadMagnet.js";
import { anyParams } from "../lib/routeParams.js";

/**
 * Кампании воронки «комментарий → чек-лист в директ».
 *
 * Права те же, что у остальных настроек бота: смотреть — `settings.view`, менять —
 * `settings.manage`. Кампания решает, что CRM напишет постороннему человеку от
 * имени компании, и это ровно тот же вес, что промт бота или ключи каналов.
 *
 * Подтверждения личности (requireElevation) здесь нет нарочно: секретов кампания
 * не содержит, а весь раздел Настроек и так открывается за step-up. Требовать его
 * ещё раз значило бы, что длинная форма с текстами упирается в «подтвердите
 * личность» ровно в момент сохранения — этот сценарий CRM уже проходила с ключами.
 */
export const leadMagnetsRouter = Router();
leadMagnetsRouter.use(requireAuth);

const CAMPAIGN_FIELDS = {
  id: true,
  name: true,
  enabled: true,
  accountId: true,
  postUrl: true,
  mediaId: true,
  postUrls: true,
  mediaIds: true,
  keywords: true,
  anyComment: true,
  publicReplies: true,
  inviteText: true,
  inviteButton: true,
  requireFollow: true,
  requireFollowAll: true,
  followText: true,
  followButton: true,
  notFollowingText: true,
  maxFollowChecks: true,
  deliverIfUnsure: true,
  deliverOnSecondClaim: true,
  deliveredText: true,
  filePath: true,
  fileName: true,
  fileSize: true,
  link: true,
  handoffToBot: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Счётчики по всем кампаниям разом — одной группировкой, а не запросом на
 * кампанию. Под рекламой выдач тысячи, а кампаний десяток: N+1 здесь стоил бы
 * ровно столько же, сколько и везде, только заметил бы его владелец не сразу.
 */
async function loadStats(): Promise<Map<string, Record<LeadMagnetState, number>>> {
  const rows = await prisma.leadMagnetDelivery.groupBy({
    by: ["campaignId", "state"],
    _count: { _all: true },
  });
  const out = new Map<string, Record<LeadMagnetState, number>>();
  for (const row of rows) {
    const bucket =
      out.get(row.campaignId) ?? { INVITED: 0, AWAITING_FOLLOW: 0, DELIVERED: 0, FAILED: 0 };
    bucket[row.state as LeadMagnetState] = row._count._all;
    out.set(row.campaignId, bucket);
  }
  return out;
}

/**
 * Сколько получивших файл дошли до карточки клиента.
 *
 * Считается ЧЕРЕЗ ДИАЛОГ, а не по своему полю: у человека из Instagram нет
 * телефона, карточку заводит обычный бот позже, когда доводит разговор до
 * контакта. Связь — subscriberId диалога, он же идентификатор человека в выдаче.
 *
 * Одним запросом на все кампании: список идентификаторов в IN, а не выборка на
 * строку.
 */
async function loadLeadCounts(campaignIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (campaignIds.length === 0) return out;

  const delivered = await prisma.leadMagnetDelivery.findMany({
    where: { campaignId: { in: campaignIds }, state: "DELIVERED" },
    select: { campaignId: true, igUserId: true },
    // Предел выборки: на большой рекламе выдач десятки тысяч, и считать точное
    // число лидов ценой выгрузки всей таблицы в память не стоит ни одного лида.
    take: 5000,
  });
  if (delivered.length === 0) return out;

  const withClient = await prisma.botConversation.findMany({
    where: {
      channel: "INSTAGRAM",
      subscriberId: { in: [...new Set(delivered.map((d) => d.igUserId))] },
      clientId: { not: null },
    },
    select: { subscriberId: true },
  });
  const clients = new Set(withClient.map((c) => c.subscriberId));
  for (const d of delivered) {
    if (clients.has(d.igUserId)) out.set(d.campaignId, (out.get(d.campaignId) ?? 0) + 1);
  }
  return out;
}

type CampaignRow = Prisma.LeadMagnetCampaignGetPayload<{ select: typeof CAMPAIGN_FIELDS }>;

function present(
  row: CampaignRow,
  stats: Map<string, Record<LeadMagnetState, number>>,
  leads: Map<string, number>
) {
  const s = stats.get(row.id) ?? { INVITED: 0, AWAITING_FOLLOW: 0, DELIVERED: 0, FAILED: 0 };
  return {
    ...row,
    // Публичный адрес файла — им же владелец проверяет, что файл вообще открывается.
    // null, если адрес CRM не настроен: тогда Meta файл забрать не сможет, и это
    // надо показать до запуска рекламы, а не выяснять по пустым выдачам.
    fileUrl: row.filePath && crmPublicBase() ? `${crmPublicBase()}${row.filePath}` : null,
    stats: {
      invited: s.INVITED + s.AWAITING_FOLLOW + s.DELIVERED + s.FAILED,
      awaitingFollow: s.AWAITING_FOLLOW,
      delivered: s.DELIVERED,
      failed: s.FAILED,
      leads: leads.get(row.id) ?? 0,
    },
  };
}

leadMagnetsRouter.get("/", requirePermission("settings.view"), async (_req, res) => {
  const rows = await prisma.leadMagnetCampaign.findMany({
    select: CAMPAIGN_FIELDS,
    orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  const [stats, leads] = await Promise.all([loadStats(), loadLeadCounts(rows.map((r) => r.id))]);
  res.json(rows.map((r) => present(r, stats, leads)));
});

/** Журнал выдач: кто пришёл, подписался ли, получил ли файл. */
const deliveriesQuery = z.object({
  campaignId: z.guid().optional(),
  state: z.enum(["INVITED", "AWAITING_FOLLOW", "DELIVERED", "FAILED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

leadMagnetsRouter.get("/deliveries", requirePermission("settings.view"), async (req, res) => {
  const parsed = deliveriesQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  const { campaignId, state, page } = parsed.data;
  const pageSize = 30;

  const where = { ...(campaignId ? { campaignId } : {}), ...(state ? { state } : {}) };
  const [total, rows] = await Promise.all([
    prisma.leadMagnetDelivery.count({ where }),
    prisma.leadMagnetDelivery.findMany({
      where,
      orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        campaignId: true,
        igUserId: true,
        username: true,
        commentText: true,
        state: true,
        followChecks: true,
        wasFollowing: true,
        deliveredAsFile: true,
        invitedAt: true,
        deliveredAt: true,
        lastError: true,
        campaign: { select: { name: true } },
      },
    }),
  ]);

  // Карточка клиента, если человек уже дошёл до неё, — одним запросом на страницу.
  const conversations = await prisma.botConversation.findMany({
    where: { channel: "INSTAGRAM", subscriberId: { in: rows.map((r) => r.igUserId) }, clientId: { not: null } },
    select: { subscriberId: true, client: { select: { id: true, shortId: true } } },
  });
  const byUser = new Map(conversations.map((c) => [c.subscriberId, c.client]));

  res.json({
    page,
    pageSize,
    total,
    items: rows.map(({ campaign, igUserId, ...row }) => ({
      ...row,
      campaignName: campaign.name,
      igUserId,
      clientId: byUser.get(igUserId)?.id ?? null,
      clientShortId: byUser.get(igUserId)?.shortId ?? null,
    })),
  });
});

/**
 * Репетиция: прогнать кампанию подставным комментарием, не трогая ни Meta, ни базу.
 * Право — на просмотр настроек: репетиция ничего не меняет и никому не пишет,
 * это чтение собственных текстов кампании в лицах.
 */
const rehearseSchema = z.object({
  comment: z.string().max(500).default(""),
  following: z.enum(["yes", "no", "unknown"]).default("yes"),
});

leadMagnetsRouter.post("/:id/rehearse", requirePermission("settings.view"), async (req, res) => {
  const parsed = rehearseSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });

  const campaign = await prisma.leadMagnetCampaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) return res.status(404).json({ error: "Кампания не найдена" });

  res.json({
    steps: rehearseCampaign(campaign, parsed.data),
    // Репетиция нарочно работает и у выключенной кампании — её и репетируют до
    // включения. Но предупредить обязаны: включить забывают.
    enabled: campaign.enabled,
  });
});

leadMagnetsRouter.post("/", requirePermission("settings.manage"), async (req, res) => {
  const parsed = leadMagnetCampaignInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });

  const created = await prisma.leadMagnetCampaign.create({
    data: {
      ...toData(parsed.data),
      createdById: req.agent?.id ?? null,
    },
    select: CAMPAIGN_FIELDS,
  });
  invalidateLeadMagnetCache();
  logAudit(req, "SETTINGS_UPDATE", "LeadMagnetCampaign", created.id, { name: created.name, created: true });
  res.status(201).json(present(created, new Map(), new Map()));
});

/**
 * ДУБЛИРОВАТЬ КАМПАНИЮ (владелец 17.08.2026: «чтобы не делать одно и то же дважды»).
 *
 * Кампании под разные ролики отличаются одной-двумя строками — публикацией и
 * ключевым словом, — а всё остальное у них общее: четыре текста воронки, правила
 * подписки, тот же PDF. Заводя вторую руками, владелец перенабирал это заново, и
 * разъехавшийся текст обнаруживался уже на оплаченной рекламе.
 *
 * КОПИЯ ВСЕГДА ВЫКЛЮЧЕНА, чем бы ни был оригинал. Сразу после создания у неё та же
 * публикация и те же ключевые слова, то есть она — двойник. Двух приглашений
 * человек не получит (pickCampaign в lib/leadMagnet.ts возвращает ПЕРВОЕ
 * совпадение), и беда была бы тише: выигрывает кампания, заведённая раньше
 * (orderBy createdAt asc), поэтому включённая копия просто ничего не делала бы —
 * а владелец правил бы её тексты и не понимал, почему в директ уходят старые.
 * Включает копию владелец сам, поменяв публикацию.
 *
 * ФАЙЛ КОПИРУЕТСЯ НА ДИСКЕ, а не переиспользуется тем же путём. Общий путь означал
 * бы, что удаление ЛЮБОЙ из двух кампаний уносит PDF у обеих (см. removeFile в
 * DELETE), и вторая молча начала бы отдавать битую ссылку — то есть поломка
 * появилась бы через недели и в чужом месте.
 *
 * Журнал выдач и счётчики не копируются: они про людей, пришедших к оригиналу.
 */
leadMagnetsRouter.post("/:id/duplicate", requirePermission("settings.manage"), async (req, res) => {
  const source = await prisma.leadMagnetCampaign.findUnique({
    where: { id: req.params.id },
    select: CAMPAIGN_FIELDS,
  });
  if (!source) return res.status(404).json({ error: "Кампания не найдена" });

  // Поля, которые у копии обязаны быть своими, вынимаем из спреда явно: id и даты
  // ставит база, файл переносится ниже отдельным шагом.
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, filePath, fileName, fileSize, ...fields } = source;

  const created = await prisma.leadMagnetCampaign.create({
    data: { ...fields, name: copyName(source.name), enabled: false, createdById: req.agent?.id ?? null },
    select: CAMPAIGN_FIELDS,
  });

  // Имя на диске содержит id кампании (см. загрузку файла), поэтому копировать
  // можно только когда id уже есть — то есть после create, вторым запросом.
  const copiedPath = filePath ? await copyStoredFile(filePath, created.id) : null;
  const withFile = copiedPath
    ? await prisma.leadMagnetCampaign.update({
        where: { id: created.id },
        data: { filePath: copiedPath, fileName, fileSize },
        select: CAMPAIGN_FIELDS,
      })
    : created;

  invalidateLeadMagnetCache();
  logAudit(req, "SETTINGS_UPDATE", "LeadMagnetCampaign", withFile.id, {
    name: withFile.name,
    created: true,
    duplicatedFrom: source.id,
  });
  // Счётчики у копии заведомо нулевые — считать их запросом незачем.
  res.status(201).json(present(withFile, new Map(), new Map()));
});

leadMagnetsRouter.patch("/:id", requirePermission("settings.manage"), async (req, res) => {
  const parsed = leadMagnetCampaignInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });

  const exists = await prisma.leadMagnetCampaign.findUnique({ where: { id: req.params.id }, select: { id: true, postUrl: true } });
  if (!exists) return res.status(404).json({ error: "Кампания не найдена" });

  const data = toData(parsed.data);
  const updated = await prisma.leadMagnetCampaign.update({
    where: { id: req.params.id },
    data: {
      ...data,
      // Публикацию сменили — забытый mediaId от прошлой стал бы ловушкой: воронка
      // продолжала бы срабатывать под СТАРЫМ роликом, и понять это по интерфейсу
      // невозможно (в форме стоит новый адрес).
      ...(data.postUrl !== exists.postUrl ? { mediaId: null } : {}),
    },
    select: CAMPAIGN_FIELDS,
  });
  invalidateLeadMagnetCache();
  logAudit(req, "SETTINGS_UPDATE", "LeadMagnetCampaign", updated.id, { name: updated.name });
  const [stats, leads] = await Promise.all([loadStats(), loadLeadCounts([updated.id])]);
  res.json(present(updated, stats, leads));
});

/**
 * Тумблер «включена/выключена». Меняет ТОЛЬКО `enabled`: раньше тумблер слал в
 * PATCH весь свой снимок кампании, и устаревший снимок молча откатывал тексты,
 * ключевые слова и адреса, сохранённые другим оператором (аудит 04.10.2026,
 * WEB-PAGES13). Условия включения те же, что у полной схемы кампании
 * (packages/shared/src/leadMagnet.ts): пустая кампания не сработает ни разу, а
 * «любой комментарий» без публикации писал бы в директ всем под любым постом.
 */
const enabledInputSchema = z.object({ enabled: z.boolean() });

leadMagnetsRouter.patch("/:id/enabled", requirePermission("settings.manage"), async (req, res) => {
  const parsed = enabledInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });

  const row = await prisma.leadMagnetCampaign.findUnique({
    where: { id: req.params.id },
    select: { id: true, keywords: true, anyComment: true, postUrl: true, postUrls: true },
  });
  if (!row) return res.status(404).json({ error: "Кампания не найдена" });

  if (parsed.data.enabled) {
    if (!row.anyComment && row.keywords.length === 0) {
      return res.status(400).json({ error: "Добавьте ключевое слово или включите ответ на любой комментарий" });
    }
    if (row.anyComment && !row.postUrl?.trim() && row.postUrls.every((u) => !u.trim())) {
      return res.status(400).json({
        error: "Для ответа на любой комментарий укажите публикацию — иначе воронка сработает под всеми постами",
      });
    }
  }

  const updated = await prisma.leadMagnetCampaign.update({
    where: { id: row.id },
    data: { enabled: parsed.data.enabled },
    select: CAMPAIGN_FIELDS,
  });
  invalidateLeadMagnetCache();
  logAudit(req, "SETTINGS_UPDATE", "LeadMagnetCampaign", updated.id, { name: updated.name, enabled: updated.enabled });
  const [stats, leads] = await Promise.all([loadStats(), loadLeadCounts([updated.id])]);
  res.json(present(updated, stats, leads));
});

leadMagnetsRouter.delete("/:id", requirePermission("settings.manage"), async (req, res) => {
  const campaign = await prisma.leadMagnetCampaign.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, filePath: true },
  });
  if (!campaign) return res.status(404).json({ error: "Кампания не найдена" });

  // Выдачи уходят вместе с кампанией (onDelete: Cascade) — журнал по удалённой
  // кампании читать негде и незачем, а идентификаторы людей хранить без причины
  // не нужно.
  await prisma.leadMagnetCampaign.delete({ where: { id: campaign.id } });
  if (campaign.filePath) await removeFile(campaign.filePath);
  invalidateLeadMagnetCache();
  logAudit(req, "SETTINGS_UPDATE", "LeadMagnetCampaign", campaign.id, { name: campaign.name, deleted: true });
  res.json({ ok: true });
});

/**
 * Файл лид-магнита. Только PDF: Instagram принимает документом именно его, и
 * «допустим любой файл» кончилось бы тем, что клиент получает .docx, который на
 * телефоне не открывается.
 *
 * Лежит в открытой папке `/uploads` НАРОЧНО: Meta забирает файл своими серверами
 * по ссылке, и закрытое хранилище переписки ей недоступно (см. lib/privateFiles.ts
 * и lib/crmPublicUrl.ts). Это осознанное решение, а не недосмотр: чек-лист —
 * рекламный материал, который мы и так раздаём всем желающим.
 */
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LEAD_MAGNET_FILE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname);
    if (!ok) return cb(new UploadRejectedError("Instagram принимает документом только PDF"));
    cb(null, true);
  },
});

const LEAD_MAGNET_DIR = "lead-magnets";

/**
 * Отказ multer превращаем в понятный 400, а не в «Внутренняя ошибка сервера».
 *
 * Ошибка из middleware улетает в общий обработчик, и владелец, приложивший .docx
 * или файл на 40 МБ, видит «внутренняя ошибка» — то есть сообщение о поломке CRM
 * вместо объяснения, что не так с его файлом. Проверено на живой загрузке: оба
 * случая давали 500.
 */
const acceptPdf: RequestHandler = (req, res, next) => {
  pdfUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
    res.status(400).json({
      error: tooBig
        ? "Instagram принимает файл до 25 МБ — этот тяжелее. Сожмите PDF или дайте ссылку."
        : err instanceof Error
          ? err.message
          : "Файл не принят",
    });
  });
};

leadMagnetsRouter.post(
  "/:id/file",
  requirePermission("settings.manage"),
  anyParams(acceptPdf),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Файл не передан" });
    const campaign = await prisma.leadMagnetCampaign.findUnique({
      where: { id: req.params.id },
      select: { id: true, filePath: true },
    });
    if (!campaign) return res.status(404).json({ error: "Кампания не найдена" });

    const dir = path.join(uploadsDir, LEAD_MAGNET_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    // Имя на диске своё, а не пришедшее от человека: в оригинале бывает и кириллица,
    // и пробелы, и «..» — а этот путь попадает в публичную ссылку, которую забирает
    // Meta. Настоящее имя храним отдельно, для интерфейса.
    const stored = `${campaign.id}-${Date.now()}.pdf`;
    await fs.promises.writeFile(path.join(dir, stored), req.file.buffer);
    if (campaign.filePath) await removeFile(campaign.filePath);

    const updated = await prisma.leadMagnetCampaign.update({
      where: { id: campaign.id },
      data: {
        filePath: `/uploads/${LEAD_MAGNET_DIR}/${stored}`,
        fileName: req.file.originalname.slice(0, 200),
        fileSize: req.file.size,
      },
      select: CAMPAIGN_FIELDS,
    });
    invalidateLeadMagnetCache();
    logAudit(req, "SETTINGS_UPDATE", "LeadMagnetCampaign", campaign.id, { file: updated.fileName });
    const [stats, leads] = await Promise.all([loadStats(), loadLeadCounts([campaign.id])]);
    res.json(present(updated, stats, leads));
  }
);

leadMagnetsRouter.delete("/:id/file", requirePermission("settings.manage"), async (req, res) => {
  const campaign = await prisma.leadMagnetCampaign.findUnique({
    where: { id: req.params.id },
    select: { id: true, filePath: true },
  });
  if (!campaign) return res.status(404).json({ error: "Кампания не найдена" });
  if (campaign.filePath) await removeFile(campaign.filePath);

  const updated = await prisma.leadMagnetCampaign.update({
    where: { id: campaign.id },
    data: { filePath: null, fileName: null, fileSize: null },
    select: CAMPAIGN_FIELDS,
  });
  invalidateLeadMagnetCache();
  const [stats, leads] = await Promise.all([loadStats(), loadLeadCounts([campaign.id])]);
  res.json(present(updated, stats, leads));
});

/** Разбор формы в поля таблицы: пустая строка адреса и ссылки — это null, а не
 *  пустая строка, иначе «ловим под любой публикацией» отличалось бы от «поле
 *  очистили» только на глаз. */
function toData(input: z.output<typeof leadMagnetCampaignInputSchema>) {
  return {
    name: input.name,
    enabled: input.enabled,
    // Пустая строка из <select> — это «любой аккаунт», то есть null, а не "".
    accountId: input.accountId || null,
    postUrl: input.postUrl?.trim() || null,
    // Пустые строки из формы отбрасываем: пустая ссылка в списке — это не «ловим
    // везде», а забытое поле, и она бы молча расширила охват кампании.
    postUrls: (input.postUrls ?? []).map((u) => u.trim()).filter(Boolean),
    keywords: input.keywords,
    anyComment: input.anyComment,
    publicReplies: input.publicReplies,
    inviteText: input.inviteText,
    inviteButton: input.inviteButton,
    requireFollow: input.requireFollow,
    requireFollowAll: input.requireFollowAll,
    followText: input.followText,
    followButton: input.followButton,
    notFollowingText: input.notFollowingText,
    maxFollowChecks: input.maxFollowChecks,
    deliverIfUnsure: input.deliverIfUnsure,
    deliverOnSecondClaim: input.deliverOnSecondClaim,
    deliveredText: input.deliveredText,
    link: input.link?.trim() || null,
    handoffToBot: input.handoffToBot,
  };
}

/**
 * Название копии. Обрезаем по той же мерке, что и форма (LEAD_MAGNET_NAME_MAX):
 * копия заводится в обход Zod-схемы, и без обрезки длинное название породило бы
 * кампанию, которую её же форма отказывается сохранять — «Изменить» упиралось бы
 * в ошибку на поле, которого владелец не трогал.
 */
function copyName(name: string): string {
  const suffix = " (копия)";
  const room = LEAD_MAGNET_NAME_MAX - suffix.length;
  return `${name.length <= room ? name : name.slice(0, room).trimEnd()}${suffix}`;
}

/**
 * Копия PDF под своим именем. Возвращает новый публичный путь или null, если
 * копировать нечего.
 *
 * Пропажа файла на диске (перенос сервера, ручная чистка `/uploads`) дублирование
 * НЕ роняет: тексты — главное, что копируется, а отсутствие файла владелец видит
 * в самой карточке кампании строкой «Отдаём текстом» и приложит PDF сам. Уронить
 * здесь ошибку значило бы не отдать и тексты.
 */
async function copyStoredFile(sourcePath: string, newCampaignId: string): Promise<string | null> {
  // Та же проверка пути, что и в removeFile: строка пришла из базы, но ходить по
  // ней в файловую систему без сверки нельзя.
  if (!sourcePath.startsWith(`/uploads/${LEAD_MAGNET_DIR}/`) || sourcePath.includes("..")) return null;
  const from = path.join(uploadsDir, sourcePath.replace("/uploads/", ""));
  const stored = `${newCampaignId}-${Date.now()}.pdf`;
  try {
    await fs.promises.mkdir(path.join(uploadsDir, LEAD_MAGNET_DIR), { recursive: true });
    await fs.promises.copyFile(from, path.join(uploadsDir, LEAD_MAGNET_DIR, stored));
    return `/uploads/${LEAD_MAGNET_DIR}/${stored}`;
  } catch (err) {
    console.error("[lead-magnets] файл кампании не скопирован:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Удаление файла с диска. Путь проверяется, а не подставляется: он приходит из
 *  базы, но это всё равно строка, а `rm` по ней — необратимая операция. */
async function removeFile(uploadPath: string): Promise<void> {
  if (!uploadPath.startsWith(`/uploads/${LEAD_MAGNET_DIR}/`) || uploadPath.includes("..")) return;
  const full = path.join(uploadsDir, uploadPath.replace("/uploads/", ""));
  await fs.promises.rm(full, { force: true }).catch(() => {});
}
