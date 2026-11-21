import { z } from "zod";
import { formatPropertyCode, isReadOnlyRole, type NarrationConfig } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor, type AssistantActionSnapshot } from "../../../lib/assistantActions.js";
import { dushanbeDateTimeString } from "../../../lib/dushanbeTime.js";
import { afterNarrationApproved, approveNarrationVersion, isNarrationOwnerRole, narrationAwaitsHuman, narrationAutoEnabled, requestAutoNarration } from "../../../lib/narrationAutoFlow.js";
import { loadNarrationConfiguration } from "../../../lib/narrationGeneration.js";
import { clipCountsAsPublished } from "../../../lib/publishedClip.js";
import { NARRATION_PRICE_NOT_IN_TJS_APPROVE_TEXT, narrationFactsCurrent, narrationScriptError } from "../../../lib/propertyNarration.js";
import { logSystemError } from "../../../lib/systemError.js";
import { matchByName, narrationAccessForAgent, narrationTemplatesFor, type NarrationClicker } from "../../../lib/staffNarration.js";
import { narrationApprovedText, sendNarrationAudioToAgent } from "../../../telegram/assistantNarration.js";
import type { AssistantActor } from "../actor.js";
import { propertyHref } from "./propertyPresenter.js";
import { resolveRefOrThrow } from "./propertyToolSupport.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin, AssistantWriteToolPlugin } from "./types.js";

/**
 * ОЗВУЧКА ОБЪЕКТА СЛОВАМИ (18.11.2026, владелец: «всё, что сотрудник делает в CRM, он делает через Шабнам —
 * текстом или голосом»): посмотреть текст озвучки, послушать её файлом и образцы голосов, сменить голос или
 * шаблон, переписать текст, одобрить.
 *
 * Своей логики здесь нет: новая версия — `requestAutoNarration` (та же дверь, что кнопки «Другой голос/шаблон»,
 * «Править текст» и мастер CRM, с тем же дневным потолком расходов), одобрение — `approveNarrationVersion` +
 * `afterNarrationApproved` (те же две функции, что кнопка «Одобрить» и маршрут approve). Права — те же, что у
 * кнопки: хозяин объекта или руководство (`narrationAccessForAgent`). Когда новая озвучка соберётся, человеку
 * приходит обычная карточка с файлом и кнопками (`notifyNarrationApproval`) — второго сообщения от инструмента нет.
 * Всё только в личке: в общей группе ни текст озвучки, ни одобрение (ролик уходит в соцсети).
 */
const TOOL_STATUS = "narration_status";
const TOOL_AUDIO = "send_narration_audio";
const TOOL_REQUEST = "request_narration";
const TOOL_APPROVE = "approve_narration";

const refSchema = z.string().trim().min(1).max(200);
const SCRIPT_MIN = 10;

const STATUS_RU: Record<string, string> = {
  DRAFT: "черновик: голос ещё не заказан",
  GENERATING: "голос готовится, подождите минуту",
  UNKNOWN: "голос готовится, исход проверяется",
  READY: "аудио готово",
  FAILED: "аудио собрать не вышло",
};

const usable = (actor: AssistantActor) => !isReadOnlyRole(actor.role) && actor.role !== "EDITOR" && actor.surface !== "telegram-group";

async function loadSubject(ref: string, agentId: string) {
  const { id } = await resolveRefOrThrow(ref);
  const access = await narrationAccessForAgent(agentId, id);
  if (!access) throw new AssistantActionError(403, "FORBIDDEN", "Озвучкой этого объекта управляет его агент или руководство");
  const property = await prisma.property.findUniqueOrThrow({ where: { id }, include: { district: true } });
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: id }, orderBy: { revision: "desc" } });
  return { access, property, latest };
}
type Subject = Awaited<ReturnType<typeof loadSubject>>;

const voiceName = (config: NarrationConfig, id: string | null | undefined) => config.voices.find((v) => v.id === id)?.name ?? null;
const templateName = (config: NarrationConfig, id: string | null | undefined) => (config.templates ?? []).find((t) => t.id === id)?.name ?? null;
const codeOf = (p: { shortId: number }) => formatPropertyCode(p.shortId);
const ownerIdOf = (p: { assignedAgentId: string | null; intakeAgentId: string | null; createdById: string | null }) => p.assignedAgentId ?? p.intakeAgentId ?? p.createdById;

/** Подсказка модели, когда имя голоса или шаблона не нашлось или подходит несколько. */
function nameError(kind: "голос" | "шаблон", query: string, result: { reason: "NONE" | "MANY"; candidates: { name: string }[] }): AssistantActionError {
  const list = result.candidates.slice(0, 12).map((c) => c.name).join(", ");
  return new AssistantActionError(400, result.reason === "MANY" ? "NAME_AMBIGUOUS" : "NAME_UNKNOWN",
    result.reason === "MANY" ? `Под «${query}» подходит несколько: ${list}. Уточните, какой ${kind}.` : `Такого (${kind}) в настройках нет: «${query}». Есть: ${list || "ничего"}.`);
}

// ───────────────────────────── narration_status ─────────────────────────────

const statusArgs = z.object({ ref: refSchema });

export const narrationStatusPlugin: AssistantReadToolPlugin = {
  name: TOOL_STATUS,
  level: "A",
  description:
    "Показать озвучку объекта: ТЕКСТ, который читает голос, какой голос и шаблон выбраны, готов ли файл и ждёт ли он одобрения; плюс список голосов и шаблонов, " +
    "из которых можно выбрать. Звать: «что там с озвучкой ОБ-205», «какой текст озвучки», «прочитай текст», «какие есть голоса». " +
    "Текст пересказывай дословно, ничего не добавляй. Послушать файл — send_narration_audio, сменить голос/шаблон/текст — request_narration, выпустить — approve_narration.",
  parameters: { type: "object", properties: { ref: { type: "string", description: "Номер объекта: «ОБ-205», «205» или id" } }, required: ["ref"] },
  statusPhrase: "Смотрю озвучку…",
  allowed: usable,
  async run(raw, { actor }) {
    const { ref } = statusArgs.parse(raw);
    const { property, latest } = await loadSubject(ref, actor.id);
    const { config } = await loadNarrationConfiguration();
    const waiting = !!latest && await narrationAwaitsHuman(property.id, property, latest);
    return {
      property: { code: codeOf(property), title: safeField(property.title, 120), href: propertyHref(property.shortId) },
      narrationOff: property.narrationOff,
      autoGenerate: narrationAutoEnabled(config),
      clipAlreadyPublished: await clipCountsAsPublished(property.id, property),
      version: latest ? {
        revision: latest.revision,
        status: latest.status,
        statusRu: STATUS_RU[latest.status] ?? latest.status,
        hasAudio: latest.status === "READY" && !!latest.storageKey,
        waitingForApproval: waiting,
        approved: !!latest.approvedAt,
        factsChangedSinceThen: !narrationFactsCurrent(latest, property),
        voice: voiceName(config, latest.voiceId),
        template: templateName(config, latest.templateId),
        language: latest.language,
        preparedAtDushanbe: dushanbeDateTimeString(latest.createdAt),
        scriptLength: latest.script.length,
        script: safeField(latest.script, 2500),
        ...(latest.mixNote ? { note: safeField(latest.mixNote, 200) } : {}),
      } : null,
      voices: config.voices.map((v) => ({ name: v.name, ...(v.gender ? { gender: v.gender } : {}) })),
      templates: narrationTemplatesFor(config, latest?.language, property.type).map((t) => ({ name: t.name, lang: t.lang })),
      hint: waiting ? "Озвучка ждёт одобрения: предложи послушать файл и одобрить." : latest ? undefined : "Озвучки ещё нет: можно заказать (request_narration).",
    };
  },
};

// ───────────────────────────── send_narration_audio ─────────────────────────────

const audioArgs = z.object({
  ref: refSchema.optional(),
  what: z.enum(["current", "samples"]),
  voice: z.string().trim().min(1).max(80).optional(),
}).refine((a) => a.what === "samples" || !!a.ref, { message: "Для готовой озвучки нужен номер объекта" });

export const sendNarrationAudioPlugin: AssistantReadToolPlugin = {
  name: TOOL_AUDIO,
  level: "A",
  description:
    "Прислать в чат ФАЙЛ: готовую озвучку объекта (what=current) или образцы голосов (what=samples, одна и та же фраза каждым голосом; voice — имя, если нужен один). " +
    "Звать: «пришли озвучку 205», «дай послушать», «как звучат голоса». Файл придёт отдельным сообщением выше твоего ответа, поэтому в ответе скажи коротко: «Прислала, послушайте». " +
    "Только в личном чате Telegram. Если образцов ещё нет — так и скажи, их готовит руководство.",
  parameters: {
    type: "object",
    properties: {
      what: { type: "string", enum: ["current", "samples"], description: "current — озвучка объекта; samples — образцы голосов" },
      ref: { type: "string", description: "Номер объекта: «ОБ-205» (нужен для what=current)" },
      voice: { type: "string", description: "Имя одного голоса из списка (для what=samples); без него — все готовые" },
    },
    required: ["what"],
  },
  statusPhrase: "Готовлю файл…",
  allowed: usable,
  async run(raw, { actor }) {
    const args = audioArgs.parse(raw);
    if (actor.surface !== "telegram-private") {
      return { error: "Файл присылаю только в личный чат Telegram. В CRM озвучку можно послушать в карточке объекта.", code: "NOT_TELEGRAM" };
    }
    if (args.what === "samples") {
      const { config } = await loadNarrationConfiguration();
      let voiceId: string | undefined;
      if (args.voice) {
        const found = matchByName(config.voices, args.voice);
        if (!found.ok) throw nameError("голос", args.voice, found);
        voiceId = found.item.id;
      }
      const sent = await sendNarrationAudioToAgent(actor.id, { samples: { voiceId } });
      if (!sent.sent) return { error: sent.reason === "NO_CHAT" ? "Личный чат с Telegram не привязан" : "Образцы голосов ещё не подготовлены: их готовит руководство", code: sent.reason ?? "NO_SAMPLES" };
      return { sent: sent.sent, note: "Файлы уже в чате." };
    }
    const { property, latest } = await loadSubject(args.ref!, actor.id);
    if (!latest || latest.status !== "READY" || !latest.storageKey) {
      return { error: latest ? `Файла пока нет: ${STATUS_RU[latest.status] ?? latest.status}` : "Озвучки ещё нет: её можно заказать", code: "NO_FILE" };
    }
    const sent = await sendNarrationAudioToAgent(actor.id, { versionId: latest.id });
    if (!sent.sent) return { error: "Не получилось отправить файл, попробуйте ещё раз", code: sent.reason ?? "SEND_FAILED" };
    return { sent: 1, property: codeOf(property), revision: latest.revision, waitingForApproval: await narrationAwaitsHuman(property.id, property, latest), note: "Файл уже в чате." };
  },
};

// ───────────────────────────── request_narration ─────────────────────────────

const requestArgs = z.object({
  ref: refSchema,
  voice: z.string().trim().min(1).max(80).optional(),
  template: z.string().trim().min(1).max(120).optional(),
  reroll: z.boolean().optional(),
  script: z.string().trim().min(SCRIPT_MIN).max(5000).optional(),
}).refine((a) => !!(a.voice || a.template || a.reroll || a.script), { message: "Скажите, что поменять: голос, шаблон или текст" });
type RequestArgs = z.infer<typeof requestArgs>;

const numbersOf = (text: string) => new Set(text.match(/\d+/gu) ?? []);

/** Всё, что проверяется и на карточке «было → станет», и перед записью (состояние читается свежим). */
async function prepareRequest(args: RequestArgs, agentId: string) {
  const subject = await loadSubject(args.ref, agentId);
  const { property, latest } = subject;
  if (property.narrationOff) throw new AssistantActionError(409, "DISABLED", "Для этого объекта выбрано «Без озвучки». Включить можно в карточке объекта.");
  const { config } = await loadNarrationConfiguration();
  if (!narrationAutoEnabled(config)) throw new AssistantActionError(409, "OFF", "Автоозвучка выключена в настройках.");
  if (latest && (latest.status === "GENERATING" || latest.status === "UNKNOWN")) throw new AssistantActionError(409, "BUSY", "Предыдущая озвучка ещё готовится. Попробуйте через минуту.");
  let voiceId: string | undefined;
  if (args.voice) {
    const found = matchByName(config.voices, args.voice);
    if (!found.ok) throw nameError("голос", args.voice, found);
    voiceId = found.item.id;
  }
  let templateId: string | undefined;
  if (args.template) {
    const found = matchByName(narrationTemplatesFor(config, latest?.language, property.type), args.template);
    if (!found.ok) throw nameError("шаблон", args.template, found);
    templateId = found.item.id;
  }
  if (args.script) {
    const problem = narrationScriptError(args.script);
    if (problem) throw new AssistantActionError(400, "INVALID", problem);
  }
  return { ...subject, config, voiceId, templateId };
}

export interface NarrationRequestSnap extends AssistantActionSnapshot {
  propertyId: string; shortId: number; revision: number; latestId: string | null; latestStatus: string | null;
}

export const requestNarrationExecutor: AssistantActionExecutor<RequestArgs> = {
  tool: TOOL_REQUEST,
  channels: ["crm", "telegram"],
  privateTelegram: true,
  parseArgs: (raw) => requestArgs.parse(raw),
  async snapshot(args, actor) {
    const { property, latest } = await loadSubject(args.ref, actor.agentId);
    return { propertyId: property.id, shortId: property.shortId, revision: latest?.revision ?? 0, latestId: latest?.id ?? null, latestStatus: latest?.status ?? null } satisfies NarrationRequestSnap;
  },
  async buildPreview(args, _snapshot, actor) {
    const { property, latest, config, voiceId, templateId } = await prepareRequest(args, actor.agentId);
    const code = codeOf(property);
    const lastScript = latest?.script ?? null;
    const newNumbers = args.script ? [...numbersOf(args.script)].filter((n) => !numbersOf(lastScript ?? "").has(n)) : [];
    const toOwner = ownerIdOf(property) !== actor.agentId;
    return {
      title: `🎙 Новая озвучка ${code}`,
      was: {
        Текст: lastScript ?? "озвучки ещё нет",
        Голос: voiceName(config, latest?.voiceId) ?? "—",
        ...(latest?.templateId ? { Шаблон: templateName(config, latest.templateId) ?? "—" } : {}),
      },
      becomes: {
        Текст: args.script ?? (args.template || args.reroll ? "CRM соберёт новый текст по шаблону" : "тот же"),
        Голос: voiceName(config, voiceId) ?? voiceName(config, latest?.voiceId) ?? "по умолчанию",
        ...(templateId ? { Шаблон: templateName(config, templateId) ?? "—" } : args.reroll ? { Шаблон: "другой случайный" } : {}),
        ...(newNumbers.length ? { Внимание: `в тексте появились числа, которых не было: ${newNumbers.slice(0, 6).join(", ")} — проверьте` } : {}),
      },
      risk: `Озвучка платная и готовится около минуты; прежняя остаётся в истории. ${toOwner ? "Готовую пришлю агенту объекта; вам — по просьбе «пришли озвучку»." : "Готовую пришлю сюда с кнопкой «Одобрить»."}`,
    };
  },
  async execute(args, actor, ctx) {
    const snap = ctx.snapshotBefore as NarrationRequestSnap;
    const { property, config, voiceId, templateId } = await prepareRequest(args, actor.agentId);
    const outcome = await requestAutoNarration({
      propertyId: property.id, actorId: actor.agentId, source: "AGENT", voiceId, templateId, reroll: args.reroll, script: args.script,
      expectedRevision: snap.revision, debounceMs: 0, config,
    });
    const refuse = (status: number, code: string, message: string) => new AssistantActionError(status, code, message);
    switch (outcome.status) {
      case "QUEUED":
        return {
          result: {
            versionId: outcome.versionId, revision: outcome.revision, status: "QUEUED", propertyShortId: property.shortId, href: propertyHref(property.shortId),
            deliversTo: ownerIdOf(property) === actor.agentId ? "you" : "owner",
            message: "Заказала новую озвучку: когда будет готова, файл придёт карточкой с кнопкой «Одобрить».",
          },
          audit: { entityType: "Property", entityId: property.id },
        };
      case "INVALID": throw refuse(400, "INVALID", outcome.error);
      case "BUSY": throw refuse(409, "BUSY", "Предыдущая озвучка ещё готовится. Попробуйте через минуту.");
      case "OFF": throw refuse(409, "OFF", "Автоозвучка выключена в настройках.");
      case "DISABLED": throw refuse(409, "DISABLED", "Для этого объекта выбрано «Без озвучки».");
      case "UNCHANGED": throw refuse(409, "UNCHANGED", "Другого подходящего шаблона нет: текст остался бы тем же.");
      default: throw refuse(409, "STALE", "Уже есть новая версия озвучки. Посмотрите её и скажите, что поменять.");
    }
  },
};

export const requestNarrationPlugin: AssistantWriteToolPlugin = {
  name: TOOL_REQUEST,
  level: "C",
  description:
    "Заказать НОВУЮ озвучку объекта: другой голос (voice — имя из narration_status), другой шаблон (template — имя из narration_status), случайный другой шаблон (reroll) " +
    "или ПЕРЕПИСАННЫЙ ТЕКСТ (script — весь текст целиком; на карточке человек увидит «было → станет»). " +
    "Звать: «поставь мужской голос в 205», «другой шаблон», «убери про ремонт», «сделай короче». Для правки текста сначала возьми текущий из narration_status " +
    "и измени только то, что просили; ничего не выдумывай — ни цену, ни этаж, ни ремонт, ни район, которых нет в тексте или карточке. Цифры можно писать цифрами: при озвучке CRM сама превратит их в слова. " +
    "Если просят изменить сами данные объекта (этаж, цена) — это не озвучка: request_property_change / change_property_price. После вызова ответь одной фразой: «Подтвердите».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-205», «205» или id" },
      voice: { type: "string", description: "Имя голоса из списка narration_status" },
      template: { type: "string", description: "Имя шаблона из списка narration_status" },
      reroll: { type: "boolean", description: "true — взять случайный другой шаблон и концовку" },
      script: { type: "string", description: "Новый текст озвучки ЦЕЛИКОМ (не фрагмент), от 10 знаков" },
    },
    required: ["ref"],
  },
  statusPhrase: "Готовлю заказ озвучки…",
  allowed: usable,
  executor: requestNarrationExecutor as unknown as AssistantWriteToolPlugin["executor"],
};

// ───────────────────────────── approve_narration ─────────────────────────────

const approveArgs = z.object({ ref: refSchema });
type ApproveArgs = z.infer<typeof approveArgs>;

export interface NarrationApproveSnap extends AssistantActionSnapshot {
  propertyId: string; shortId: number; versionId: string | null; revision: number; status: string | null; approved: boolean;
}

async function checkApprovable(subject: Subject): Promise<NonNullable<Subject["latest"]>> {
  const { property, latest, access } = subject;
  if (!latest) throw new AssistantActionError(409, "NO_VERSION", "Озвучки ещё нет: сначала её нужно заказать.");
  if (latest.status !== "READY" || !latest.storageKey) throw new AssistantActionError(409, "NOT_READY", `Озвучка ещё не готова: ${STATUS_RU[latest.status] ?? latest.status}.`);
  if ((latest.source ?? "MANUAL") === "MANUAL" && !latest.approvedAt && !await clipCountsAsPublished(property.id, property)) throw new AssistantActionError(409, "MANUAL", "Эту озвучку одобряют в карточке объекта в CRM.");
  // Аудио по тексту маркетинга и самоодобренное на вышедшем ролике тоже ждут человека (ревью 18.11) — те же права.
  if (!await narrationAwaitsHuman(property.id, property, latest)) throw new AssistantActionError(409, "ALREADY", "Эту озвучку уже одобрили.");
  if (latest.source === "BACKFILL" && !isNarrationOwnerRole(access.role)) throw new AssistantActionError(403, "FORBIDDEN", "Эту озвучку одобряет владелец (директор).");
  if (!narrationFactsCurrent(latest, property)) throw new AssistantActionError(409, "STALE", "Данные объекта изменились после подготовки озвучки. Нужна новая озвучка с актуальными данными.");
  return latest;
}

const approveClicker = async (actor: AssistantActionActor, propertyId: string): Promise<NarrationClicker> => {
  const clicker = await narrationAccessForAgent(actor.agentId, propertyId);
  if (!clicker) throw new AssistantActionError(403, "FORBIDDEN", "Озвучкой этого объекта управляет его агент или руководство");
  return clicker;
};

export const approveNarrationExecutor: AssistantActionExecutor<ApproveArgs> = {
  tool: TOOL_APPROVE,
  channels: ["crm", "telegram"],
  privateTelegram: true,
  parseArgs: (raw) => approveArgs.parse(raw),
  async snapshot(args, actor) {
    const { property, latest } = await loadSubject(args.ref, actor.agentId);
    return { propertyId: property.id, shortId: property.shortId, versionId: latest?.id ?? null, revision: latest?.revision ?? 0, status: latest?.status ?? null, approved: !!latest?.approvedAt } satisfies NarrationApproveSnap;
  },
  async buildPreview(args, _snapshot, actor) {
    const subject = await loadSubject(args.ref, actor.agentId);
    const latest = await checkApprovable(subject);
    const { config } = await loadNarrationConfiguration();
    return {
      title: `✅ Одобрить озвучку ${codeOf(subject.property)}`,
      was: { Статус: "ждёт одобрения", Текст: latest.script, Голос: voiceName(config, latest.voiceId) ?? "—", Версия: latest.revision },
      becomes: { Статус: "одобрена и идёт в работу" },
      risk: "После одобрения озвучка идёт в ролик (монтажёру или CRM заменит в нём звук), а ролик выходит в соцсети. Отменить нельзя: поправить можно только новой озвучкой.",
      irreversible: true,
    };
  },
  async execute(_args, actor, ctx) {
    const snap = ctx.snapshotBefore as NarrationApproveSnap;
    if (!snap.versionId) throw new AssistantActionError(409, "NO_VERSION", "Озвучки ещё нет");
    const clicker = await approveClicker(actor, snap.propertyId);
    // Одна функция одобрения с кнопкой «Одобрить» и маршрутом approve, затем та же передача дальше.
    const approval = await approveNarrationVersion({ propertyId: snap.propertyId, versionId: snap.versionId, expectedRevision: snap.revision, actorId: clicker.agentId, isManager: clicker.isManager, actorRole: clicker.role });
    if (approval === "FORBIDDEN") throw new AssistantActionError(403, "FORBIDDEN", "Эту озвучку вам одобрять нельзя");
    if (approval === "PRICE_NOT_IN_TJS") throw new AssistantActionError(409, "PRICE_NOT_IN_TJS", NARRATION_PRICE_NOT_IN_TJS_APPROVE_TEXT);
    if (approval !== "AUDIO_APPROVED") throw new AssistantActionError(409, "STALE", "Уже есть новая версия озвучки или данные объекта изменились: посмотрите актуальную.");
    let delivery: Awaited<ReturnType<typeof afterNarrationApproved>> | null = null;
    try { delivery = await afterNarrationApproved(snap.propertyId, snap.versionId); }
    catch (err) {
      // Одобрение записано; передача дальше не вышла — честно говорим, кнопка «Одобрить» под карточкой повторит её.
      void logSystemError("ai", `Озвучка, одобрение словами: передача дальше не вышла: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-approve-tool-delivery" });
    }
    return {
      result: {
        versionId: snap.versionId, revision: snap.revision, approved: true, delivery, propertyShortId: snap.shortId, href: propertyHref(snap.shortId),
        message: delivery ? narrationApprovedText(delivery) : "Одобрено, но передать дальше сразу не вышло. Нажмите «Одобрить» под карточкой озвучки ещё раз или проверьте в CRM.",
      },
      audit: { entityType: "Property", entityId: snap.propertyId },
    };
  },
};

export const approveNarrationPlugin: AssistantWriteToolPlugin = {
  name: TOOL_APPROVE,
  level: "C",
  description:
    "Одобрить готовую озвучку объекта: после этого она идёт в ролик, а ролик выходит в соцсети. Звать: «выпускай», «одобряю озвучку 205», «всё хорошо, давай». " +
    "Одобряется только готовая озвучка последней версии; если её ещё нет или она не готова — отказ с причиной, перескажи её. " +
    "Если человек не слышал файл и не видел текст — предложи сначала послушать (send_narration_audio). После вызова ответь одной фразой: «Подтвердите».",
  parameters: { type: "object", properties: { ref: { type: "string", description: "Номер объекта: «ОБ-205», «205» или id" } }, required: ["ref"] },
  statusPhrase: "Готовлю одобрение озвучки…",
  allowed: usable,
  executor: approveNarrationExecutor as unknown as AssistantWriteToolPlugin["executor"],
};

export const narrationTools: readonly (AssistantReadToolPlugin | AssistantWriteToolPlugin)[] = [
  narrationStatusPlugin,
  sendNarrationAudioPlugin,
  requestNarrationPlugin,
  approveNarrationPlugin,
];

/** Для теста-сторожа группы Telegram (assistantBot.ts, GROUP_HIDDEN_TOOLS): имена буквами, сверка с реестром. */
export const NARRATION_TOOL_NAMES = [TOOL_STATUS, TOOL_AUDIO, TOOL_REQUEST, TOOL_APPROVE] as const;
