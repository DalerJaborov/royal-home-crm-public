// Текущие промпты и наборы функций CRM для каждого вида исходящего звонка.
// Берутся из ИСХОДНИКОВ apps/api/src (через tsx), а не копируются: проверка идёт на тех
// текстах, которые робот получит на настоящем звонке. Базу и сеть не трогает.
import { register } from "tsx/esm/api";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { CLIENT_CARD_CALL_TOOLS } from "./client-call-tools.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "apps", "api", "src", rel)).href;
let registered = false;

/** Сборка промптов не ходит в базу, но модуль db.js требует строку адреса при импорте. */
function ensureOfflineEnv() {
  process.env.DATABASE_URL ||= "postgresql://offline:offline@127.0.0.1:1/offline";
  if (!registered) {
    register();
    registered = true;
  }
}

/** Фиксированный момент, чтобы текст приглашения не плавал от запуска к запуску: 14.11.2026, 14:00 по Душанбе. */
const INTERVIEW_AT = new Date("2026-11-14T09:00:00Z");
const SHOWING_AT_LABEL = "сегодня днём";

/**
 * Один вид звонка = { kind, label, prompt, greeting, tools, language, expectsTool }.
 * expectsTool — функция, до которой разговор обязан дойти при успешном исходе.
 */
export async function loadCrmCallKinds() {
  ensureOfflineEnv();
  const [invite, post, probe, persona] = await Promise.all([
    import(src("ai/interviewInviteCallPersona.ts")),
    import(src("ai/postShowingCallPersona.ts")),
    import(src("ai/sellerProbeCallPersona.ts")),
    import(src("ai/liveVoicePersona.ts")),
  ]);
  const { CLIENT_TOOLS } = await import(src("lib/telephony/liveVoiceClientTools.ts"));
  const { PROPERTY_TOOLS } = await import(src("lib/telephony/liveVoicePropertyTools.ts"));

  const inviteCtx = (language) => ({
    candidateName: "Мехрона",
    interviewAt: INTERVIEW_AT,
    address: null,
    language,
    previous: null,
  });
  const postCtx = {
    clientName: "Фарход",
    propertyTitle: "2-комнатная квартира в Сино",
    agentName: "Мадина",
    whenLabel: SHOWING_AT_LABEL,
    voiceGender: "female",
  };
  const probeCtx = {
    sellerName: "Рустам",
    propertyLabel: "трёхкомнатную на Фирдавси",
    voiceGender: "female",
  };
  // Настоящий исходящий звонок клиенту по кнопке в карточке: замок «только русский» в базе по умолчанию выключен
  // (Settings.liveVoiceForceRussianOnly = false), функции — только LIVE_VOICE_TOOLS моста (client-call-tools.mjs).
  const cardPrompt = (propertyDescription) =>
    persona.buildLiveVoiceSystemPrompt({ clientName: "Зарина", propertyDescription }, { forceRussianOnly: false });
  return [
    {
      kind: "client-card",
      label: "Звонок клиенту из карточки (по объекту)",
      language: "ru",
      prompt: cardPrompt("2-комнатная квартира, Сино, 62 кв. м"),
      greeting: "(Собеседник снял трубку. Поздоровайся и представься.)",
      tools: CLIENT_CARD_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "client-card-open",
      label: "Звонок клиенту из карточки (без объекта)",
      language: "ru",
      prompt: cardPrompt(null),
      greeting: "(Собеседник снял трубку. Поздоровайся и представься.)",
      tools: CLIENT_CARD_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "invite-ru",
      label: "Приглашение кандидата (ru)",
      language: "ru",
      prompt: invite.buildInterviewInviteCallPrompt(inviteCtx("ru")),
      greeting: invite.INTERVIEW_INVITE_GREETING_TRIGGER,
      tools: invite.INTERVIEW_INVITE_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "invite-tg",
      label: "Приглашение кандидата (tg)",
      language: "tg",
      prompt: invite.buildInterviewInviteCallPrompt(inviteCtx("tg")),
      greeting: invite.INTERVIEW_INVITE_GREETING_TRIGGER,
      tools: invite.INTERVIEW_INVITE_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "post-showing",
      label: "Опрос после показа",
      language: "ru",
      prompt: post.buildPostShowingCallPrompt(postCtx, true),
      greeting: post.POST_SHOWING_CALL_GREETING_TRIGGER,
      tools: post.POST_SHOWING_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "seller-probe",
      label: "Проверка собственника",
      language: "ru",
      prompt: probe.buildSellerProbeCallPrompt(probeCtx, true),
      greeting: probe.SELLER_PROBE_CALL_GREETING_TRIGGER,
      tools: probe.SELLER_PROBE_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "client",
      label: "Звонок клиенту",
      language: "ru",
      prompt: persona.buildLiveVoiceSystemPrompt(
        { clientName: "Зарина", propertyDescription: "2-комнатная квартира, Сино, 62 кв. м" },
        { forceRussianOnly: true }
      ),
      greeting: "(Собеседник снял трубку. Поздоровайся и представься.)",
      tools: [...CLIENT_TOOLS, ...PROPERTY_TOOLS],
      expectsTool: "save_client_request",
    },
  ];
}

/** Настройки и сборщики PATCH — те же функции, что зовёт сервер (ai/elevenLabsAgentSync.ts). */
export async function loadAgentSync() {
  ensureOfflineEnv();
  const m = await import(src("ai/elevenLabsAgentSync.ts"));
  return {
    tuning: m.ELEVENLABS_PHONE_AGENT_TUNING,
    buildAgentSyncPatch: m.buildAgentSyncPatch,
    buildAgentTuningPatch: m.buildAgentTuningPatch,
    toElevenLabsClientTool: m.toElevenLabsClientTool,
  };
}
