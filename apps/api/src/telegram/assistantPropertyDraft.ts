import { randomUUID } from "node:crypto";
import {
  buildCreateBody, PROPERTY_CONDITIONS, PROPERTY_CONDITION_LABELS, PROPERTY_TYPES, PROPERTY_TYPE_LABELS, propertyCreateSchema, type PermissionId,
  propertyWizardDraftValuesSchema, type PropertyWizardDraftValues,
} from "@royal-home/shared";
import { z } from "zod";
import { isAiAssistantEnabled } from "../ai/assistant.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { can, canBindClient, invalidateAgentAccess, loadAgentAccess, type AgentAccess } from "../auth/middleware.js";
import { prisma, type TxClient } from "../db.js";
import { findActiveAgentByName } from "../lib/agentNameLookup.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";
import { lookupGeoPoint } from "../lib/geoLookup.js";
import { districtFromMap } from "../lib/propertyDistrict.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { createProperty, formatGeoAddressGuess } from "../routes/properties/crud.js";
import { savePropertyDraftPhotos } from "../routes/properties/drafts.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, draftExpiry, draftMediaFingerprint, withDraftLock, type DraftRecord } from "../routes/properties/draftLifecycle.js";
import { assignableAgentError, propertyCreateDeniedReason } from "../routes/properties/shared.js";
import { answerCallbackQuery, editMessageText, sendMessage, sendMessageWithButtons, type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton } from "./api.js";
import { downloadAssistantMedia } from "./assistantMedia.js";
import { extractPropertyFields } from "./assistantPropertyFields.js";

const kind = "property-draft";
const expiresAt = () => new Date(Date.now() + 12 * 60 * 60_000);
const isStart = /^(?:\/(?:new_property|object)(?:@\w+)?|(?:(?:давай|хочу)\s+)?(?:добавь|добавим|добавить|создай|создадим|создать)\s+(?:новый\s+)?объект|объекти нав|объект илова кун)[.!?]*$/iu;
const isExit = /^(?:\/(?:cancel|new|reset)|выход|выйти из черновика)$/iu;
const callback = /^pdt:(review|create|exit):([\da-f-]{36})$/u;
const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const stateSchema = z.object({
  draftId: z.guid(),
  preview: z.object({ token: z.guid(), revision: z.number().int(), media: z.string() }).optional(),
});
type State = z.infer<typeof stateSchema>;
type Transcribe = (msg: TelegramIncomingMessage, agentId: string, wallet: AssistantMoneyWallet) => Promise<{ text: string } | { error: string }>;
type Context = { chatId: string; agentId: string; fullName: string; access: AgentAccess & { id: string; can: (permission: PermissionId) => boolean } };
const missingLabels: Record<string, string> = {
  type: "тип", condition: "ремонт", price: "цена", currency: "валюта", rooms: "комнаты",
  areaSqm: "площадь", landAreaSotka: "сотки", floor: "этаж", totalFloors: "этажей",
  windowCount: "окна", districtId: "район", address: "адрес", ownerContact: "телефон продавца",
  clientId: "продавец", sellerName: "имя продавца",
};
const howTo = "Пришлите голосовое с описанием, фото и геоточку через скрепку. Исправить поле можно сообщением, например «Этаж: 5».";
const stale = "Черновик изменился. Нажмите «Проверить черновик» ещё раз или откройте мастер командой /new_property.";

function readState(row: { agentId: string; kind: string; expiresAt: Date; payload: unknown } | null, agentId: string) {
  if (!row || row.agentId !== agentId || row.kind !== kind || row.expiresAt <= new Date()) return null;
  const state = stateSchema.safeParse(row.payload);
  return state.success ? state.data : null;
}

async function getState(tx: TxClient, chatId: string, agentId: string) {
  return readState(await tx.telegramDialogState.findUnique({ where: { chatId } }), agentId);
}

async function updateState(tx: TxClient, { chatId, agentId }: Context, state: State) {
  await tx.telegramDialogState.updateMany({ where: { chatId, agentId, kind }, data: { payload: state, expiresAt: expiresAt() } });
}

const controls = (draftId: string): TelegramInlineButton[][] => [[
  { text: "Проверить черновик", callback_data: `pdt:review:${draftId}` },
  { text: "Выйти", callback_data: `pdt:exit:${draftId}` },
]];

function readyPhotos(draft: DraftRecord) {
  return draft.media.filter(file => file.kind === "PHOTO" && file.status === "READY");
}

async function review(ctx: Context, draft: DraftRecord) {
  const values = propertyWizardDraftValuesSchema.parse(draft.values);
  const body = buildCreateBody(values);
  const parsed = propertyCreateSchema.safeParse(body);
  const missing = parsed.success ? [] : parsed.error.issues.map(issue =>
    issue.path[0] === "floor" && values.floor ? issue.message : missingLabels[String(issue.path[0])] ?? issue.message);
  if (!values.sellerClientId && !values.sellerName?.trim()) missing.push("имя продавца");
  if (values.lat == null || values.lng == null) missing.push("геоточка");
  const photos = readyPhotos(draft);
  if (!photos.length) missing.push("фото");
  if (draft.media.some(file => file.status !== "READY")) missing.push("дождитесь обработки всех файлов или проверьте их в мастере CRM");
  const [district, intake, seller] = await Promise.all([
    values.districtId ? prisma.district.findUnique({ where: { id: values.districtId }, select: { name: true } }) : null,
    can({ agent: ctx.access }, "properties.editForeign") && values.intakeAgentId
      ? prisma.agent.findUnique({ where: { id: values.intakeAgentId }, select: { fullName: true } }) : null,
    values.sellerClientId ? prisma.client.findUnique({ where: { id: values.sellerClientId }, select: { fullName: true, assignedAgentId: true, deletedAt: true } }) : null,
  ]);
  if (values.districtId && !district) missing.push("район из справочника");
  const canEditForeign = can({ agent: ctx.access }, "properties.editForeign");
  if (canEditForeign) {
    if (!intake || !values.intakeAgentId) missing.push("кто принял объект (напишите «Агент: имя»)");
    else {
      const error = await assignableAgentError(values.intakeAgentId);
      if (error) missing.push(error);
    }
  }
  const sellerVisible = seller && !seller.deletedAt && canBindClient({ agent: ctx.access }, seller);
  if (values.sellerClientId && !sellerVisible) missing.push("доступная карточка продавца в CRM");
  const type = z.enum(PROPERTY_TYPES).safeParse(values.type);
  const condition = z.enum(PROPERTY_CONDITIONS).safeParse(values.condition);
  const amount = values.price && new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(Number(values.price));
  const digits = values.sellerPhone?.replace(/\D/g, "");
  const phone = digits && digits.length >= 9 ? ` · •••• ${digits.slice(-2)}` : "";
  const lines = [
    "📋 Черновик объекта",
    type.success && PROPERTY_TYPE_LABELS[type.data],
    amount && `Цена: ${amount} ${values.currency === "TJS" ? "сомони" : values.currency === "USD" ? "долларов" : ""}`.trim(),
    [
      values.areaSqm && values.type !== "LAND" && `${values.areaSqm} м²`,
      values.landAreaSotka && `${values.landAreaSotka} соток`,
      values.rooms && `${values.rooms} комн.`,
      values.floor && `этаж ${values.floor}${values.totalFloors ? `/${values.totalFloors}` : ""}`,
      !values.floor && values.totalFloors && `этажей: ${values.totalFloors}`,
      values.windowCount && `окон: ${values.windowCount}`,
    ].filter(Boolean).join(" · "),
    condition.success && `Ремонт: ${PROPERTY_CONDITION_LABELS[condition.data]}`,
    district && `Район: ${district.name}`,
    values.address && "Адрес сохранён в мастере CRM",
    `Геоточка: ${values.lat != null && values.lng != null ? "получена" : "ожидаю"} · Фото: ${photos.length}`,
    (sellerVisible || values.sellerName) && `Продавец: ${sellerVisible ? seller.fullName : values.sellerName}${values.sellerClientId ? "" : phone}`,
    `Принял объект: ${canEditForeign ? intake?.fullName ?? "выберите агента" : ctx.fullName}`,
    values.offSite ? "Размещение: только CRM" : "Размещение: обычный объект",
    missing.length
      ? `\nНужно ещё: ${[...new Set(missing)].join(", ")}.\n${howTo}`
      : "\nВсё заполнено. Проверьте данные и нажмите «Создать».",
  ].filter(Boolean).join("\n");
  return { lines, missing, body };
}

async function sendReview(ctx: Context, draft: DraftRecord, prefix?: string) {
  const info = await review(ctx, draft);
  const buttons = controls(draft.id);
  if (!info.missing.length) {
    const token = randomUUID();
    const ready = await withDraftLock(ctx.agentId, async tx => {
      const state = await getState(tx, ctx.chatId, ctx.agentId);
      if (state?.draftId !== draft.id) return false;
      const current = await assertActiveDraft(tx, ctx.agentId, { draftId: draft.id, revision: draft.revision });
      const media = draftMediaFingerprint(draft);
      if (draftMediaFingerprint(current) !== media) return false;
      await updateState(tx, ctx, { draftId: draft.id, preview: { token, revision: draft.revision, media } });
      return true;
    });
    if (!ready) { await sendMessageWithButtons(ctx.chatId, stale, buttons); return; }
    buttons.unshift([{ text: "Создать", callback_data: `pdt:create:${token}` }]);
  }
  await sendMessageWithButtons(ctx.chatId, prefix ? `${prefix}\n\n${info.lines}` : info.lines, buttons);
}

async function startDraft(ctx: Context) {
  return withDraftLock(ctx.agentId, async tx => {
    const row = await tx.telegramDialogState.findUnique({ where: { chatId: ctx.chatId } });
    if (row && row.expiresAt > new Date() && (row.agentId !== ctx.agentId || ![kind, "assistant"].includes(row.kind))) return null;
    const current = await tx.propertyDraft.findUnique({ where: { agentId: ctx.agentId }, include: DRAFT_INCLUDE });
    const blank = { id: randomUUID(), values: {}, step: 0, closedAt: null, expiresAt: draftExpiry() };
    const draft = current && !current.closedAt
      ? await tx.propertyDraft.update({ where: { id: current.id }, data: { expiresAt: draftExpiry() }, include: DRAFT_INCLUDE })
      : await tx.propertyDraft.upsert({
        where: { agentId: ctx.agentId },
        create: { ...blank, agentId: ctx.agentId, revision: 1 },
        update: { ...blank, revision: { increment: 1 } },
        include: DRAFT_INCLUDE,
      });
    const data = { agentId: ctx.agentId, kind, payload: { draftId: draft.id }, expiresAt: expiresAt() };
    await tx.telegramDialogState.upsert({ where: { chatId: ctx.chatId }, create: { chatId: ctx.chatId, ...data }, update: data });
    return draft;
  });
}

async function saveFields(ctx: Context, draft: DraftRecord, patch: PropertyWizardDraftValues) {
  return withDraftLock(ctx.agentId, async tx => {
    const state = await getState(tx, ctx.chatId, ctx.agentId);
    if (state?.draftId !== draft.id) throw new DraftConflictError(null);
    const current = await assertActiveDraft(tx, ctx.agentId, { draftId: draft.id, revision: draft.revision });
    const values = propertyWizardDraftValuesSchema.parse({ ...propertyWizardDraftValuesSchema.parse(current.values), ...patch });
    const updated = await tx.propertyDraft.update({
      where: { id: draft.id }, data: { values, revision: { increment: 1 }, expiresAt: draftExpiry() }, include: DRAFT_INCLUDE,
    });
    await updateState(tx, ctx, { draftId: draft.id });
    return updated;
  });
}

async function exitDraft(ctx: Context, draftId: string) {
  const removed = await withDraftLock(ctx.agentId, async tx => {
    if ((await getState(tx, ctx.chatId, ctx.agentId))?.draftId !== draftId) return false;
    await tx.telegramDialogState.deleteMany({ where: { chatId: ctx.chatId, agentId: ctx.agentId, kind } });
    return true;
  });
  if (removed) await sendMessage(ctx.chatId, "Вышли из мастера. Черновик сохранён. Вернуться можно командой /new_property.");
}

async function updateLocation(ctx: Context, draft: DraftRecord, point: z.infer<typeof location>) {
  const values = propertyWizardDraftValuesSchema.parse(draft.values);
  const lat = point.latitude;
  const lng = point.longitude;
  const map = await districtFromMap({ lat, lng });
  const geo = !values.address || (!map && !values.districtId) ? await lookupGeoPoint(lat, lng) : null;
  const districtId = map?.id ?? values.districtId ?? geo?.district?.id;
  const address = values.address || (geo && formatGeoAddressGuess(geo));
  const next = await saveFields(ctx, draft, {
    lat, lng, ...(districtId ? { districtId } : {}), ...(address ? { address } : {}),
  });
  await sendReview(ctx, next, "Геоточка сохранена.");
}

async function updateDescription(ctx: Context, draft: DraftRecord, text: string, wallet: AssistantMoneyWallet) {
  const buttons = controls(draft.id);
  const access = { agent: ctx.access };
  const placement = /^(?:размещение:\s*)?(только crm|обычный объект)$/iu.exec(text);
  if (placement) {
    await sendReview(ctx, await saveFields(ctx, draft, { offSite: placement[1].toLowerCase() === "только crm" }));
    return;
  }
  let extracted;
  try {
    extracted = await extractPropertyFields(text.slice(0, 5000), ctx.agentId, wallet);
  } catch (error) {
    if (error instanceof Error && error.message === "draft_daily_limit") {
      await sendMessageWithButtons(ctx.chatId, "На сегодня закончился лимит разбора описаний. Заполните поля по одному, например «Площадь: 68».", buttons);
      return;
    }
    await sendMessageWithButtons(ctx.chatId, "Не разобрала поля. Напишите каждое с новой строки: «Цена: 750000», «Валюта: сомони», «Площадь: 68».", buttons);
    return;
  }
  const { districtName, intakeAgentName, ...patch } = extracted;
  const values: PropertyWizardDraftValues = { ...patch };
  const notes: string[] = [];
  if (districtName) {
    const id = await findDistrictIdByName(districtName);
    if (id) values.districtId = id;
    else notes.push("Район не совпал со справочником. Уточните его название.");
  }
  if (intakeAgentName && can(access, "properties.editForeign")) {
    const match = await findActiveAgentByName(intakeAgentName);
    if (match.kind !== "one") notes.push(match.kind === "many"
      ? `Уточните имя агента: ${match.candidates.map(candidate => candidate.fullName).join(", ")}.`
      : "Агента не нашла. Напишите полное имя.");
    else {
      const error = await assignableAgentError(match.agent.id);
      if (error) notes.push(error);
      else values.intakeAgentId = match.agent.id;
    }
  }
  if (values.address || values.districtId) {
    const previous = propertyWizardDraftValuesSchema.parse(draft.values);
    const map = await districtFromMap({ lat: previous.lat, lng: previous.lng, address: values.address ?? previous.address });
    if (map) values.districtId = map.id;
  }
  const currentValues = propertyWizardDraftValuesSchema.parse(draft.values);
  if (currentValues.sellerClientId && (values.sellerName || values.sellerPhone)) {
    // Existing linked seller is retained until the employee changes it in the wizard.
    delete values.sellerName;
    delete values.sellerPhone;
    notes.push("Продавец уже привязан к черновику. Сменить карточку можно в мастере CRM.");
  }
  if (!Object.keys(values).length) {
    await sendMessageWithButtons(ctx.chatId, notes.join("\n") || "Новых полей не нашла. Пришлите описание объекта или напишите, что исправить.", buttons);
    return;
  }
  await sendReview(ctx, await saveFields(ctx, draft, values), notes.join("\n") || undefined);
}

export async function handleTelegramPropertyDraft(
  msg: TelegramIncomingMessage, agent: { id: string; fullName: string }, transcribe: Transcribe,
): Promise<boolean> {
  if (msg.chat.type !== "private" || !msg.from || msg.from.id !== msg.chat.id) return false;
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? msg.caption ?? "").trim();
  const start = isStart.test(text);
  const state = await getState(prisma, chatId, agent.id);
  if (!start && !state) return false;
  const access = await loadAgentAccess(agent.id);
  const ctx = access && { chatId, agentId: agent.id, fullName: agent.fullName, access: { ...access, id: agent.id, can: (permission: PermissionId) => access.permissions.has(permission) } };
  const denied = ctx && propertyCreateDeniedReason({ agent: ctx.access });
  if (!ctx?.access.isActive || denied || !(await isAiAssistantEnabled())) {
    await sendMessage(chatId, denied ?? "Мастер объектов сейчас недоступен.");
    return true;
  }
  try {
    if (start) {
      const draft = await startDraft(ctx);
      if (draft) await sendReview(ctx, draft);
      else await sendMessage(chatId, "Сначала завершите текущее действие в чате.");
    } else if (state && isExit.test(text)) {
      await exitDraft(ctx, state.draftId);
    } else if (state) {
      const draft = await assertActiveDraft(prisma, agent.id, { draftId: state.draftId });
      const picture = msg.photo?.at(-1);
      if (picture) {
        const maxBytes = 10_000_000;
        if (picture.file_size && picture.file_size > maxBytes) throw new Error("photo_too_large");
        const buffer = await downloadAssistantMedia(picture.file_id, maxBytes);
        const saved = await savePropertyDraftPhotos(agent.id, draft.id, [
          { buffer, mimetype: "image/jpeg", size: buffer.length, originalname: `telegram-${msg.message_id}.jpg` },
        ], [`tg:${draft.id}:${msg.message_id}`]);
        if (saved.status !== 201 && saved.status !== 200) {
          await sendMessageWithButtons(chatId, "error" in saved.body ? saved.body.error : "Фото не сохранилось. Пришлите его ещё раз.", controls(draft.id));
        } else if (text) {
          await updateDescription(ctx, draft, text, createAssistantMoneyWallet());
        } else if (!msg.media_group_id) {
          await sendReview(ctx, await assertActiveDraft(prisma, agent.id, { draftId: draft.id }), "Фото добавлено.");
        }
      } else if (msg.location) {
        await updateLocation(ctx, draft, location.parse(msg.location));
      } else if (msg.voice || msg.audio) {
        const wallet = createAssistantMoneyWallet();
        const voice = await transcribe(msg, agent.id, wallet);
        if ("error" in voice) await sendMessageWithButtons(chatId, voice.error, controls(draft.id));
        else await updateDescription(ctx, draft, voice.text, wallet);
      } else if (text && !text.startsWith("/")) {
        if (/^(?:черновик|проверь черновик|покажи черновик)$/iu.test(text)) await sendReview(ctx, draft);
        else await updateDescription(ctx, draft, text, createAssistantMoneyWallet());
      } else {
        await sendMessageWithButtons(chatId, howTo, controls(draft.id));
      }
    }
  } catch (error) {
    const message = error instanceof DraftConflictError ? stale
      : error instanceof Error && error.message === "photo_too_large" ? "Пришлите фото размером до 10 МБ."
      : "Не получилось обновить черновик. Попробуйте ещё раз.";
    if (!(error instanceof DraftConflictError)) console.warn("[telegram:property-draft] intake failed", { kind: error instanceof Error ? error.name : "unknown" });
    if (state) await sendMessageWithButtons(chatId, message, controls(state.draftId));
    else await sendMessage(chatId, message);
  }
  return true;
}

export async function handleTelegramPropertyDraftCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!query.data?.startsWith("pdt:")) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const action = callback.exec(query.data);
  const chat = query.message?.chat;
  const messageId = query.message?.message_id;
  if (!action || !messageId || chat?.type !== "private" || query.from?.id !== chat.id) {
    await answer("Кнопка доступна только в личке автора");
    return true;
  }
  const chatId = String(chat.id);
  const agent = await findAgentByTelegramChatId(chatId);
  if (!agent || !(await isAiAssistantEnabled())) { await answer("Мастер недоступен"); return true; }
  invalidateAgentAccess(agent.id);
  const access = await loadAgentAccess(agent.id);
  const ctx = access && { chatId, agentId: agent.id, fullName: agent.fullName, access: { ...access, id: agent.id, can: (permission: PermissionId) => access.permissions.has(permission) } };
  if (!ctx?.access.isActive || propertyCreateDeniedReason({ agent: ctx.access })) { await answer("Нет прав на создание"); return true; }
  const [, command, id] = action;
  const state = await getState(prisma, chatId, agent.id);
  if (!state || (command === "create" ? state.preview?.token !== id : state.draftId !== id)) {
    await answer("Кнопка устарела");
    return true;
  }
  await answer();
  try {
    if (command === "exit") { await exitDraft(ctx, id); return true; }
    if (command === "review") {
      await sendReview(ctx, await assertActiveDraft(prisma, agent.id, { draftId: id }));
      return true;
    }
    const claimed = await withDraftLock(agent.id, async tx => {
      const current = await getState(tx, chatId, agent.id);
      const preview = current?.preview;
      if (!current || preview?.token !== id) return null;
      const draft = await assertActiveDraft(tx, agent.id, { draftId: current.draftId, revision: preview.revision });
      if (draftMediaFingerprint(draft) !== preview.media) throw new DraftConflictError(draft);
      await updateState(tx, ctx, { draftId: draft.id });
      return { draft, media: preview.media };
    });
    if (!claimed) return true;
    const info = await review(ctx, claimed.draft);
    if (info.missing.length) { await sendReview(ctx, claimed.draft); return true; }
    const result = await createProperty({
      agent: ctx.access, source: "telegram", expectedDraftMedia: claimed.media,
      body: { ...info.body, draftId: claimed.draft.id, draftRevision: claimed.draft.revision },
    });
    if (result.status !== 201) {
      const reply = "code" in result.body && result.body.code === "DRAFT_CONFLICT" ? stale
        : "existingPropertyId" in result.body ? "В CRM уже есть похожий объект. Проверьте его перед созданием."
        : result.status === 403 ? "CRM отклонила создание. Проверьте права и карточку продавца."
        : "CRM отклонила черновик. Проверьте поля и продавца в мастере.";
      await sendMessageWithButtons(chatId, reply, controls(claimed.draft.id));
      return true;
    }
    await withDraftLock(agent.id, async tx => {
      if ((await getState(tx, chatId, agent.id))?.draftId === claimed.draft.id) {
        await tx.telegramDialogState.deleteMany({ where: { chatId, agentId: agent.id, kind } });
      }
    });
    const created = z.object({ id: z.guid(), shortId: z.number().int() }).parse(result.body);
    const number = `ОБ-${String(created.shortId).padStart(6, "0")}`;
    const base = process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://crm.royalhome.tj";
    const buttons = [[{ text: `Открыть ${number}`, url: `${base}/properties/${created.id}` }]];
    const media = "media" in result.body ? result.body.media : undefined;
    const skipped = (media?.skipped.photos ?? 0) + (media?.skipped.videos ?? 0);
    const message = media?.error || skipped
      ? `✅ Объект создан. ${media?.error ?? `Файлов не перенеслось: ${skipped}. Добавьте их в карточке.`}`
      : "✅ Объект создан. Фотографии и геоточка в карточке.";
    try { await editMessageText(chatId, messageId, message, buttons); }
    catch { await sendMessageWithButtons(chatId, message, buttons); }
  } catch (error) {
    if (error instanceof DraftConflictError) {
      await sendMessageWithButtons(chatId, stale, controls(state.draftId));
    } else {
      console.warn("[telegram:property-draft] confirmation failed", { kind: error instanceof Error ? error.name : "unknown" });
      await sendMessage(chatId, "Не удалось подтвердить результат. Проверьте список объектов в CRM перед повтором.");
    }
  }
  return true;
}
