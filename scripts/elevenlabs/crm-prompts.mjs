// Текущие промпты и наборы функций CRM для каждого вида исходящего звонка.
// Берутся из ИСХОДНИКОВ apps/api/src (через tsx), а не копируются: проверка идёт на тех
// текстах, которые робот получит на настоящем звонке. Базу и сеть не трогает.
import { register } from "tsx/esm/api";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

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
  const recruit = await import(src("lib/recruitmentCommunicationContent.ts"));
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
  const recruitPrompt = (purpose, language) =>
    recruit.buildRecruitmentCommunicationContent(
      { purpose, language, channels: ["ASSISTANT_CALL"], ...(purpose === "INVITE" ? { interviewAt: INTERVIEW_AT.toISOString() } : {}) },
      {
        name: "Мехрона",
        titleRu: "Агент по продажам недвижимости",
        titleTg: "Агенти фурӯши молу мулк",
        detailsRu: "Полный день, доход от процента со сделок, обучение и наставник.",
        detailsTg: "Рӯзи пурра, даромад аз фоизи созишҳо, омӯзиш ва роҳбалад.",
        address: "Душанбе, ул. Бухоро 49, Bukhoro Tower, 2 этаж",
        addressTg: "Душанбе, кӯчаи Бухоро 49, Bukhoro Tower, ошёнаи 2",
        mapUrl: null,
        missing: ["age", "experience", "startWhen"],
      }
    ).callPrompt;
  return [
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
    // ── Виды, которых не было в первом наборе (проверяющий штата, 11.11.2026) ──
    {
      kind: "invite-moved-ru",
      label: "Приглашение: собеседование ПЕРЕНЕСЛИ (ru)",
      language: "ru",
      prompt: invite.buildInterviewInviteCallPrompt({
        ...inviteCtx("ru"),
        previous: { interviewAt: new Date("2026-11-12T06:00:00Z"), askedByCandidate: false },
      }),
      greeting: invite.INTERVIEW_INVITE_GREETING_TRIGGER,
      tools: invite.INTERVIEW_INVITE_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "post-showing-tg",
      label: "Опрос после показа, замок на русский ВЫКЛЮЧЕН (tg)",
      language: "tg",
      prompt: post.buildPostShowingCallPrompt(postCtx, false),
      greeting: post.POST_SHOWING_CALL_GREETING_TRIGGER,
      tools: post.POST_SHOWING_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      kind: "seller-probe-tg",
      label: "Проверка собственника, замок на русский ВЫКЛЮЧЕН (tg)",
      language: "tg",
      prompt: probe.buildSellerProbeCallPrompt(probeCtx, false),
      greeting: probe.SELLER_PROBE_CALL_GREETING_TRIGGER,
      tools: probe.SELLER_PROBE_CALL_TOOLS,
      expectsTool: "end_call",
    },
    {
      // Проверка собственника НЕ после показа (sourceKind != POST_SHOWING): промпт зашит строкой в lib/sellerProbeCall.ts
      // (runSellerProbeCall, ветка newSource) — копия дословно; при смене текста там обновить здесь.
      kind: "seller-probe-new",
      label: "Проверка собственника, новый источник (короткий промпт из sellerProbeCall.ts)",
      language: "ru",
      prompt:
        "Вы сотрудник Royal Home. Честно скажите, что уточняете данные квартиры «2-комнатная квартира в Сино». Спросите, является ли собеседник собственником, продаётся ли квартира, или планы изменились. Не утверждайте, что реклама сейчас идёт или что показ был. Не обвиняйте, не обещайте автоматического снятия. При просьбе не звонить закончите разговор. Используйте инструмент завершения разговора.",
      greeting: probe.SELLER_PROBE_CALL_GREETING_TRIGGER,
      tools: probe.SELLER_PROBE_CALL_TOOLS,
      expectsTool: "end_call",
    },
    // ── Звонок помощника кандидату из карточки отклика (lib/recruitmentCommunications.ts, ASSISTANT_CALL) ──
    // Свой промпт (recruitmentCommunicationContent.ts), не тот, что у «приглашения» выше. Данные вакансии
    // здесь условные: в боевом вызове их отдаёт каталог вакансий, а не вымысел скрипта.
    ...["ru", "tg"].flatMap((language) => [
      {
        kind: `recruit-invite-${language}`,
        label: `Помощник кандидату из карточки отклика: приглашение (${language})`,
        language,
        prompt: recruitPrompt("INVITE", language),
        greeting: "(Кандидат снял трубку. Представься голосовым помощником Royal Home и спроси, удобно ли говорить.)",
        tools: invite.INTERVIEW_INVITE_CALL_TOOLS,
        expectsTool: "end_call",
      },
      {
        kind: `recruit-clarify-${language}`,
        label: `Помощник кандидату из карточки отклика: уточнение анкеты (${language})`,
        language,
        prompt: recruitPrompt("CLARIFY", language),
        greeting: "(Кандидат снял трубку. Представься голосовым помощником Royal Home и спроси, удобно ли говорить.)",
        tools: invite.INTERVIEW_INVITE_CALL_TOOLS,
        expectsTool: "end_call",
      },
    ]),
    {
      // Кнопка «Тестовый звонок» в Настройках: общий промпт консультанта без клиента (originateLiveVoiceTestCall).
      kind: "test-call",
      label: "Тестовый звонок из Настроек (общий консультант, без клиента)",
      language: "ru",
      prompt: persona.buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: true }),
      greeting: "(Собеседник снял трубку. Поздоровайся и представься.)",
      tools: [...CLIENT_TOOLS, ...PROPERTY_TOOLS],
      expectsTool: null,
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
