import { normalizeDaysOff } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { detectClientLanguage } from "../../ai/clientLanguage.js";
import { contactProfileBlock } from "../../ai/contactProfileBlock.js";
import type { LiveVoiceFunctionDeclaration, LiveVoiceToolCall } from "../../ai/liveVoiceClient.js";
import {
  buildConsultantSystemPrompt,
  CONSULTANT_AGENT_MISSED_TRIGGER,
  CONSULTANT_RETURNED_TRIGGER,
  consultantGreetingLanguage,
  pickConsultantGreetingTrigger,
  withGreetingLanguage,
  type ConsultantCaller,
} from "../../ai/liveVoiceConsultantPersona.js";
import { loadLiveVoiceKnowledge } from "../../ai/liveVoiceKnowledge.js";
import type { LeadDraft } from "../../ai/leadQualifier.js";
import { sendPushToAgent } from "../../push.js";
import { claimAutoTaskSlot } from "../autoTasks.js";
import { attachContactProfile, recordContactTurn, setContactNameFromCall } from "../contactProfiles.js";
import { contactProfileForPrompt } from "../contactProfileMemory.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { findClientByPhoneDigits } from "../whatsappPhone.js";
import { dedupePhones, pickFreeExtraPhones } from "../clientPhones.js";
import { extractAllPhones } from "../../ai/leadQualifier.js";
import { looksLikeNoContactComplaint, looksLikeWantsHumanAgent } from "../../ai/complaintGuard.js";
import { BW, TAIL } from "../../ai/wordBoundary.js";
import { findAgentsWithPermission } from "../recipients.js";
import { logTimeline } from "../timeline.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import { isWithinConsultantHours } from "./consultantHours.js";
import { callbackPromise, loadClientHours } from "../../ai/agencyFacts.js";
import { loadBotCapabilities } from "../../messengers/botCapabilities.js";
import { sanitizeSpokenName } from "../spokenName.js";
import { autoLeadFromIncomingCall } from "./autoLeadFromCall.js";
import { callbackDueAt, pickCallbackAgent } from "./consultantCallbackTarget.js";
import { poorLineCallbackNote } from "./liveVoicePoorLine.js";
import { LIVE_TRANSCRIPT_UNRELIABLE_NOTE, liveTranscriptUnreliable, reliableCallerText } from "./liveVoiceCallerLanguage.js";
import { CONSULTANT_CARD_MIN_SECONDS, noteConsultantReturned, noteConsultantSession, type ConsultantCallEnded } from "./incomingCalls.js";
import {
  describeDiscussedProperties,
  handlePropertyTool,
  newPropertyCallMemory,
  PROPERTY_TOOLS,
  type PropertyCallMemory,
} from "./liveVoicePropertyTools.js";
import { handleTransferTool, TRANSFER_TOOL } from "./liveVoiceTransfer.js";
import { clientRequestText, CLIENT_TOOLS, handleClientTool } from "./liveVoiceClientTools.js";
import { handsCallerBackToDialplan, LIVE_VOICE_VOICE_NAME } from "./liveVoiceBridge.js";
import type {
  LiveVoiceCallInfo,
  LiveVoiceCallTask,
  LiveVoiceGateSettings,
  LiveVoiceScenarioResult,
  LiveVoiceToolReply,
} from "./liveVoiceBridge.js";

/**
 * КОНСУЛЬТАНТ НА ТЕЛЕФОНЕ — ПРИКЛАДНАЯ ЧАСТЬ (24.09.2026, решение владельца).
 *
 * Мост (liveVoiceBridge.ts) умеет разговаривать и не знает ничего о CRM. Здесь —
 * всё, что делает разговор консультацией агентства:
 *  - кто звонит: карточка по номеру, её агент, досье собеседника — ОБЩЕЕ с чат-ботом
 *    (lib/contactProfiles.ts): что человек рассказал в WhatsApp, голос знает, и
 *    наоборот;
 *  - что знать: справочник агентства, тот же, что у чат-бота
 *    (ai/liveVoiceKnowledge.ts);
 *  - квартиры: подбор, объект по номеру или адресу, ссылки по СМС
 *    (liveVoicePropertyTools.ts);
 *  - перевод живого звонка агенту (liveVoiceTransfer.ts);
 *  - что запомнить после: язык и касание — в то же досье.
 *
 * Регистрируется в мосту крючком (setLiveVoiceCallResolver, src/index.ts), а не
 * импортом из моста: мост не должен тянуть за собой CRM.
 *
 * НАСТОЯЩИЕ ВХОДЯЩИЕ (правка 5): станция отдаёт звонок консультанту вместо
 * автоответчика (Настройки → «Живой голос» → когда брать). Разговор ложится в
 * запись звонка в карточке, звонок уходит в раздачу лидов тем же путём, что звонок
 * оператору (autoLeadFromCall.ts), а своему клиенту — задача агенту перезвонить.
 */

/** Какие функции есть у консультанта. save_contact — свой, не мостовой: номер у
 *  входящего уже есть, и спрашивать его обязательным полем значит учить модель
 *  диктовать номер человеку, который с него звонит. */
export const CONSULTANT_SAVE_CONTACT_TOOL: LiveVoiceFunctionDeclaration = {
  name: "save_contact",
  description:
    "Запомнить, как зовут звонящего, как только он представился. Вызывай молча, сразу, не дожидаясь конца разговора. " +
    "Номер передавай ТОЛЬКО если человек сам попросил звонить на другой номер (не на тот, с которого звонит) или продиктовал номер, потому что его собственный скрыт, и только полностью.",
  parameters: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "Имя, которым человек назвал себя сам." },
      phone: { type: "STRING", description: "Другой номер для связи, если человек его продиктовал. Иначе не передавай." },
    },
    required: ["name"],
  },
};

/** Суть разговора для агента: её читают в пуше и в карточке, а не в расшифровке. */
const SUMMARY_FOR_AGENT = "Для агента, одной-двумя фразами: кто звонил, что хочет, о чём договорились.";

const ESCALATE_AND_END: LiveVoiceFunctionDeclaration[] = [
  {
    name: "escalate_to_human",
    description:
      "Вызови, когда собеседник ЯВНО просит живого человека, а соединить не вышло; когда просит другого агента вместо своего; или разговор зашёл в тупик. " +
      "Обычное прощание («спасибо, я подумаю») — НЕ сюда, а end_call. Перед вызовом вслух коротко, своими словами: попросишь коллегу набрать. Функция сама завершит звонок.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: SUMMARY_FOR_AGENT } },
      required: ["reason"],
    },
  },
  {
    name: "end_call",
    description:
      "Вызови ПОСЛЕ того, как вслух попрощались и разговор закончен. Кладёт трубку, поэтому сначала прощание, потом функция.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: SUMMARY_FOR_AGENT } },
      required: ["reason"],
    },
  },
];

export const CONSULTANT_TOOLS: LiveVoiceFunctionDeclaration[] = [
  CONSULTANT_SAVE_CONTACT_TOOL,
  ...PROPERTY_TOOLS,
  ...CLIENT_TOOLS,
  TRANSFER_TOOL,
  ...ESCALATE_AND_END,
];

/** Всё, что консультант узнал о звонящем до ответа. */
export interface IdentifiedCaller {
  phone: string | null;
  clientId: string | null;
  contactProfileId: string | null;
  caller: ConsultantCaller;
  /** Язык, на котором человек обычно пишет нам ("tg" | "ru" | …) — для голоса. */
  language: string | null;
  /** Строка журнала входящих (IncomingCall.id): звонок настоящий, станция его
   *  завела. null — проверочный звонок или тестовый номер. */
  incomingCallId: string | null;
  /** Что CRM решила про перевод этого входящего агенту (IncomingCall.routeDecision):
   *  "routed"/"routed_mobile" — агенту ДЕЙСТВИТЕЛЬНО звонили; иное — звонок до агента
   *  не доходил. null — звонок вне журнала или решение ещё не записано. */
  routeDecision: string | null;
  /** Личные выходные агента клиента (Agent.weeklyDaysOff, 11.10.2026): обещание звонка —
   *  на ЕГО рабочий день. Пусто — выходных нет. */
  assignedAgentDaysOff: number[];
}

/** Черновика разговора у голоса нет: досье печатается целиком. */
const EMPTY_DRAFT = { stage: "chatting" } as LeadDraft;

/**
 * ЗВОНЯЩИЙ УЗНАН ТОЛЬКО ПО НОМЕРУ — ПОДРОБНОСТЕЙ ДОСЬЕ НЕ ЗНАЕТ (02.10.2026, аудит,
 * пункт 20). Номер входящего подделывается: с чужого номера можно было выспросить у
 * робота, что клиент искал, про его квартиру и анкету кандидата — защита стояла
 * только текстом «не пересказывай». Теперь модель этих подробностей не получает
 * вовсе: имя (его печатает приветствие), на каком языке говорит и тема —
 * «покупатель / продавец / кандидат». Что искал, про свой объект, анкета, история и
 * прошлые роли в промт входящего не попадают. Звонок от нас (мы набрали номер) и
 * проверочный из Настроек номер не подделывают — там досье целиком.
 */
export function callerDossierForPrompt(
  profile: Awaited<ReturnType<typeof contactProfileForPrompt>>,
  direction: LiveVoiceCallInfo["direction"] | "outbound"
): Awaited<ReturnType<typeof contactProfileForPrompt>> {
  if (!profile || direction !== "inbound") return profile;
  return { ...profile, previousCategories: [], history: null, buyer: [], seller: [], job: [], crm: null };
}

/**
 * Узнать звонящего. Не бросает: незнакомец — это тоже ответ, а отказ базы не повод
 * не взять трубку.
 */
export async function identifyCaller(info: Pick<LiveVoiceCallInfo, "channelId" | "direction" | "callerNumber">): Promise<IdentifiedCaller> {
  // Входящий, который станция уже завела в журнал (ariEvents → startIncomingCall):
  // там карточка найдена и досье привязано ещё на гудке — второй раз не ищем.
  const incoming =
    info.direction === "inbound"
      ? await prisma.incomingCall
          .findUnique({
            where: { channelId: info.channelId },
            select: { id: true, phone: true, clientId: true, contactProfileId: true, routeDecision: true },
          })
          .catch(() => null)
      : null;
  const phone = incoming?.phone || info.callerNumber?.trim() || null;

  let clientId = incoming?.clientId ?? null;
  if (!clientId && phone) {
    const match = await findClientByPhoneDigits(phone).catch(() => null);
    // Карточка в Корзине — не клиент: её удалил человек, и узнавать по ней звонящего
    // значит вернуть то, что убрали руками (тот же принцип, что у досье).
    clientId = match && !match.deletedAt ? match.id : null;
  }
  const client = clientId
    ? await prisma.client
        .findUnique({
          where: { id: clientId },
          select: {
            deletedAt: true,
            assignedAgent: { select: { fullName: true, isActive: true, frozenAt: true, weeklyDaysOff: true } },
          },
        })
        .catch(() => null)
    : null;
  if (client?.deletedAt) clientId = null;

  const contactProfileId =
    incoming?.contactProfileId ??
    (phone
      ? await attachContactProfile({
          existingProfileId: null,
          identities: [{ kind: "PHONE", value: phone, trust: "TRANSPORT" }],
          // Ссылку хранит сама запись сессии (LiveVoiceSession.contactProfileId),
          // её пишет мост при старте — отдельной таблице писать нечего.
          link: async () => {},
        })
      : null);
  const profile = await contactProfileForPrompt(contactProfileId, EMPTY_DRAFT);

  const agent = client && !client.deletedAt ? client.assignedAgent : null;
  return {
    phone,
    clientId,
    contactProfileId,
    language: profile?.language ?? null,
    incomingCallId: incoming?.id ?? null,
    routeDecision: incoming?.routeDecision ?? null,
    assignedAgentDaysOff: agent?.isActive && !agent.frozenAt ? normalizeDaysOff(agent.weeklyDaysOff) : [],
    caller: {
      numberKnown: !!phone,
      selfName: profile?.selfName ?? null,
      // Агента называем по имени, как его зовут клиенты: «Умед», а не «Умед Сафаров».
      // Уволенного и замороженного (отпуск) не называем: звонок такого агента
      // обещать нельзя (02.10.2026).
      agentName:
        agent?.isActive && !agent.frozenAt && agent.fullName.trim() ? agent.fullName.trim().split(/\s+/)[0] : null,
      // Без кода карточки CRM: голосу он не нужен, а вслух прозвучать может (02.10.2026).
      // Узнанному ТОЛЬКО по номеру входящему досье урезано до имени и темы (см.
      // callerDossierForPrompt).
      dossier: contactProfileBlock(callerDossierForPrompt(profile, info.direction), { withCrmCard: false }),
      language: profile?.language ?? null,
    },
  };
}

/**
 * ГОЛОС ПО ЯЗЫКУ ЧЕЛОВЕКА (24.09.2026, Dan: «два голоса, русский и таджикский, по
 * языку клиента»). Голос Gemini Live выбирается один раз на весь звонок, поэтому
 * решаем до ответа — по языку из общего досье (чат-бот и прошлые звонки пишут его
 * туда же). Говорил по-таджикски — таджикский голос; по-русски — основной. Замок
 * «только русский» — всегда основной.
 *
 * НЕЗНАКОМЕЦ (языка в досье нет) — ТАДЖИКСКИЙ ГОЛОС (02.10.2026, аудит
 * надёжности). Без замка незнакомца консультант встречает по-таджикски
 * («ассалому алейкум, слушаю вас», liveVoiceConsultantPersona.ts::greetingRule),
 * а голос до этой правки ставился русский — первое слово звонка звучало с
 * акцентом. Таджикский голос не задан — основной, как раньше.
 */
export function consultantVoiceName(
  settings: Pick<LiveVoiceGateSettings, "liveVoiceVoiceName" | "liveVoiceVoiceNameTajik" | "liveVoiceForceRussianOnly"> | null,
  language: string | null
): string | undefined {
  if (!settings) return undefined;
  if (!settings.liveVoiceForceRussianOnly && (language === "tg" || !language) && settings.liveVoiceVoiceNameTajik) {
    return settings.liveVoiceVoiceNameTajik;
  }
  // Явно основной, а не «пусто»: пустое мост заменил бы общим выбором голоса, а он
  // при снятом замке берёт таджикский для всех.
  return settings.liveVoiceVoiceName || LIVE_VOICE_VOICE_NAME;
}

/**
 * ЯЗЫК ЗВОНКА ПО ДОСЬЕ (02.10.2026, второй поставщик голоса — ElevenLabs, ему
 * язык задаётся на весь разговор). То же правило, что у голоса выше, только не
 * зависит от того, заведён ли таджикский голос Gemini.
 *
 * ТАДЖИКСКИЙ ПО УМОЛЧАНИЮ (10.10.2026, владелец: «таджикский — в приоритете»). Замок
 * снят — таджикский всем, кроме тех, кто говорил с нами по-русски (досье «ru»): раньше
 * незнакомец получал русский, и робот по мусорной расшифровке прыгал между языками.
 * Дальше язык меняет только речь звонящего (liveVoiceCallerLanguage.ts). Замок —
 * русский, как раньше.
 */
export function consultantLanguage(
  settings: Pick<LiveVoiceGateSettings, "liveVoiceForceRussianOnly"> | null,
  language: string | null
): "ru" | "tg" {
  if (settings?.liveVoiceForceRussianOnly ?? true) return "ru";
  return language === "ru" ? "ru" : "tg";
}

/** Что консультант собрал по ходу звонка — живёт до итога. */
export interface ConsultantCallState {
  channelId: string;
  direction: LiveVoiceCallInfo["direction"];
  contactProfileId: string | null;
  name: string | null;
  otherPhone: string | null;
  /** Обсуждённые квартиры и СМС (liveVoicePropertyTools.ts). */
  properties: PropertyCallMemory;
  /** Суть разговора для агента — из перевода, прощания или просьбы о человеке. */
  summary: string | null;
  /** Звонок настоящий (IncomingCall есть): итог ложится в карточку и в раздачу. */
  incomingCallId: string | null;
  /** Окно решения робота, зафиксированное НА СТАРТЕ звонка (третий аудит, п.18): «скоро
   *  перезвонит» он пообещал в рабочее время, и задача после звонка, перевалившего
   *  за закрытие, остаётся «через 15 минут», а не уходит на утро без пуша. */
  promisedSoon?: boolean;
  /** Звонок агента человеку обещан (P0-2): escalate_to_human, отказ функции с
   *  «агент наберёт», и т. п. Итог звонка обязан поставить задачу исполнителю. */
  callbackPromised?: boolean;
}

/**
 * ОБЕЩАН ЛИ ЗВОНОК АГЕНТА — ПО САМОМУ РАЗГОВОРУ (09.10.2026, аудит P0-2). Робот говорит
 * «агент наберёт» и по промту, и по подсказке каждого отказа функции, а задача
 * «перезвонить» ставилась только своему клиенту. Признаки по расшифровке: робот
 * УТВЕРДИЛ звонок (вопрос «Хотите, агент наберёт?» — ещё не обещание), либо человек
 * прямо просил живого человека или жаловался, что ему не перезвонили (те же
 * распознаватели, что у чат-бота, ai/complaintGuard.ts).
 */
const CALLBACK_PROMISE_RE = new RegExp(
  `${BW}(?:перезвон${TAIL}|набер[её]т|наберут|позвонит|позвонят|свяжется|свяжутся|занг\\s+мезан${TAIL}|тамос\\s+мегир${TAIL})`,
  "iu"
);

export function callbackPromisedInTranscript(transcript: readonly string[]): boolean {
  for (const line of transcript) {
    if (line.startsWith("Бот:")) {
      const said = line.slice("Бот:".length);
      const statements = said.split(/(?<=[.!?])\s+/).filter((s) => !/\?\s*$/.test(s));
      if (statements.some((s) => CALLBACK_PROMISE_RE.test(s))) return true;
    } else if (line.startsWith("Клиент:")) {
      const said = line.slice("Клиент:".length);
      if (looksLikeWantsHumanAgent(said) || looksLikeNoContactComplaint(said)) return true;
    }
  }
  return false;
}

/** Жалоба «мне обещали перезвонить — никто не позвонил» (P1-8): поднимает руководство. */
export function noContactComplaintInTranscript(transcript: readonly string[]): boolean {
  return transcript.some((line) => line.startsWith("Клиент:") && looksLikeNoContactComplaint(line.slice("Клиент:".length)));
}

/** Ответ функции велит модели сказать, что агент наберёт: значит, звонок обещан. */
function replyPromisesCallback(reply: LiveVoiceToolReply | null): boolean {
  if (!reply) return false;
  const r = reply.response as { ok?: unknown; error?: unknown; note?: unknown };
  const text = `${typeof r.error === "string" ? r.error : ""} ${typeof r.note === "string" ? r.note : ""}`;
  return r.ok === false && /набер[её]т/iu.test(text);
}

/**
 * Собрать задание на один звонок: роль, справочник, досье, функции. Регистрируется
 * в мосту через setLiveVoiceCallResolver (src/index.ts).
 */
export async function resolveConsultantCall(info: LiveVoiceCallInfo): Promise<LiveVoiceCallTask> {
  const [who, knowledge, withinWorkingHours, clientHours, abilities] = await Promise.all([
    identifyCaller(info),
    loadLiveVoiceKnowledge(),
    isWithinConsultantHours(),
    loadClientHours(),
    // Тот же тумблер показов, что у чата (Settings.botCanBookShowings, 10.10.2026, P1-3).
    loadBotCapabilities(),
  ]);
  // Когда позвонит агент — одно решение с чатом (ai/agencyFacts.ts::callbackPromise).
  // Свой клиент: по выходным ЕГО агента (11.10.2026) — в личный выходной агента «сегодня»
  // не обещаем, а называем его следующий рабочий день. Сам звонок своему агенту в его
  // выходной идёт как обычно (inboundRouting.ts не трогался): робот здесь, только если
  // агент не взял трубку.
  const promise = callbackPromise(new Date(), clientHours, who.assignedAgentDaysOff);
  const state: ConsultantCallState = {
    channelId: info.channelId,
    direction: info.direction,
    contactProfileId: who.contactProfileId,
    name: null,
    otherPhone: null,
    summary: null,
    incomingCallId: who.incomingCallId,
    // «Сегодня» обещано только при promise.kind === "today" (за час до закрытия — уже завтра).
    promisedSoon: withinWorkingHours && promise.kind === "today",
    properties: newPropertyCallMemory({
      callerPhone: who.phone,
      clientId: who.clientId,
      contactProfileId: who.contactProfileId,
      tajikAllowed: !(info.settings?.liveVoiceForceRussianOnly ?? true),
    }),
  };
  const weCalled = info.direction !== "inbound";
  // Вернулся от агента, который не взял трубку, — второй раз туда же не соединяем:
  // человек уже послушал гудки, и агент перезвонит сам. То же, если свой клиент
  // звонил агенту, а тот не ответил: соединять снова не с кем. И в нерабочее время
  // (02.10.2026, аудит): перевод там отказывает всегда (liveVoiceTransfer.ts), а
  // функция в списке заставляла модель сначала пообещать «сейчас соединю».
  // Проверочный звонок из Настроек (мы набрали сами, weCalled) перевода не получает: на
  // «соедините» зазвонил бы настоящий агент (третий аудит, раздел «Прочее», п.16).
  const transferAvailable = withinWorkingHours && !weCalled && !info.returnedFromAgent && !info.agentMissed;
  // Звонок вернулся от агента, который не взял трубку: засчитывать этот разговор ему
  // уже нельзя (incomingCalls.ts, transferAgent).
  if (info.returnedFromAgent) noteConsultantReturned(info.channelId);
  return {
    systemInstruction: buildConsultantSystemPrompt({
      knowledge,
      caller: { ...who.caller, weCalled },
      withinWorkingHours,
      callbackPromise: promise,
      showingsEnabled: abilities.showings,
      forceRussianOnly: info.settings?.liveVoiceForceRussianOnly ?? true,
      language: consultantLanguage(info.settings, who.language),
      transferAvailable,
      reentry: info.returnedFromAgent
        ? "returned"
        : info.agentMissed && agentWasRung(who.routeDecision)
          ? "agentMissed"
          : null,
    }),
    greetingTrigger: info.returnedFromAgent
      ? CONSULTANT_RETURNED_TRIGGER
      : info.agentMissed
        ? agentWasRung(who.routeDecision)
          ? CONSULTANT_AGENT_MISSED_TRIGGER
          : AGENT_NOT_RUNG_TRIGGER
        : weCalled
          ? pickConsultantGreetingTrigger(true)
          : // Первое слово незнакомцу — по-таджикски (10.10.2026): служебная реплика по-русски
            // сама по себе тянула модель здороваться по-русски.
            withGreetingLanguage(
              pickConsultantGreetingTrigger(false),
              consultantGreetingLanguage(info.settings?.liveVoiceForceRussianOnly ?? true, who.language)
            ),
    tools: transferAvailable ? CONSULTANT_TOOLS : CONSULTANT_TOOLS.filter((t) => t.name !== TRANSFER_TOOL.name),
    voiceName: consultantVoiceName(info.settings, who.language),
    language: consultantLanguage(info.settings, who.language),
    clientId: who.clientId,
    contactProfileId: who.contactProfileId,
    onToolCall: (call, toolCtx) => handleConsultantTool(state, call, toolCtx?.isCancelled),
    onFinished: (result) => finishConsultantCall(state, result),
  };
}

/**
 * АГЕНТУ ДЕЙСТВИТЕЛЬНО ЗВОНИЛИ? (02.10.2026, аудит, Б11). Станция отдаёт роботу «своего
 * клиента, чей агент не ответил» и тогда, когда агенту НЕ звонили вовсе: замороженный,
 * без телефона, не на связи, занят — перевод не состоялся ещё до гудка. Робот при этом
 * говорил «агент не взял трубку», хотя трубку никто не поднимал и не звонил.
 * Звонили — только при решении «routed»/«routed_mobile» (lib/telephony/inboundRouting.ts).
 */
export function agentWasRung(routeDecision: string | null): boolean {
  return routeDecision === "routed" || routeDecision === "routed_mobile";
}

/** Свой клиент звонил агенту, но до агента звонок не дошёл (его нет на связи): станция
 *  отдала звонок консультанту. Не «агент не взял трубку» — агенту не звонили. */
export const AGENT_NOT_RUNG_TRIGGER =
  "(Звонок только что соединился: человек звонил своему агенту, но сейчас соединить с агентом не получилось — до него звонок не дошёл. " +
  "Ответь первым, коротко, как отвечают в офисе. Не говори, что агент «не взял трубку» или «не ответил»: ему не звонили. " +
  "Скажи, что сейчас с агентом не соединить и агент наберёт сам (без «он»/«она»), и своими словами спроси, что подсказать до этого.)";

/** Функции консультанта. null — функция общая, её ведёт мост. */
export async function handleConsultantTool(
  state: ConsultantCallState,
  call: LiveVoiceToolCall,
  isCancelled?: () => boolean
): Promise<LiveVoiceToolReply | null> {
  // Суть для агента модель сама пишет в перевод, прощание и просьбу о человеке —
  // запоминаем её, а обработку этих функций оставляем, где была.
  const said = typeof call.args.summary === "string" ? call.args.summary : typeof call.args.reason === "string" ? call.args.reason : "";
  if (said.trim() && (call.name === TRANSFER_TOOL.name || call.name === "end_call" || call.name === "escalate_to_human")) {
    state.summary = said.trim().slice(0, 500);
  }
  // Просьба о человеке, которого не соединили: робот сказал «попрошу коллегу набрать».
  if (call.name === "escalate_to_human") state.callbackPromised = true;
  if (call.name === TRANSFER_TOOL.name) {
    const reply = await handleTransferTool(
      { channelId: state.channelId, clientId: state.properties.clientId, callerName: state.name, properties: state.properties, isCancelled },
      call
    );
    if (replyPromisesCallback(reply)) state.callbackPromised = true;
    return reply;
  }
  // Статус, условия, перезвон на время человека, показ, мессенджер, «что рядом»
  // (liveVoiceClientTools.ts, 09.10.2026). Перезвон или показ, переданный агенту, —
  // обещанный звонок: итог обязан поставить задачу исполнителю.
  const clientReply = await handleClientTool(state.properties, call);
  if (clientReply) {
    if (state.properties.callbackAt || state.properties.showingWish || replyPromisesCallback(clientReply)) state.callbackPromised = true;
    return clientReply;
  }
  if (call.name !== "save_contact") {
    const reply = await handlePropertyTool(state.properties, call);
    if (replyPromisesCallback(reply)) state.callbackPromised = true;
    return reply;
  }
  // Имя — от модели и из речи звонящего: чистим до записи в досье и в пуш
  // (lib/spokenName.ts). Фраза вместо имени не сохраняется вовсе.
  const name = sanitizeSpokenName(call.args.name) ?? "";
  const phone = typeof call.args.phone === "string" ? call.args.phone.trim() : "";
  if (name) {
    state.name = name;
    // Имя, названное самим человеком, — в общее досье: в следующий раз его по имени
    // встретит и голос, и чат-бот. Досье узнано по номеру, а номер в звонке
    // подделывается — поэтому уже записанное имя не затирается (02.10.2026,
    // setContactNameFromCall в lib/contactProfiles.ts).
    if (state.contactProfileId) await setContactNameFromCall(state.contactProfileId, name);
  }
  // Номер короче семи цифр — это обрывок, а не номер (живой звонок 14.09.2026:
  // «88» ушло как телефон). Не записываем и честно говорим модели.
  if (phone && phone.replace(/\D/g, "").length < 7) {
    return { response: { ok: false, error: "номер неполный — дослушай до конца" }, scheduling: "WHEN_IDLE" };
  }
  if (phone) state.otherPhone = state.properties.otherPhone = phone;
  return { response: { ok: true }, scheduling: "SILENT" };
}

/**
 * Итог одной сессии консультанта. Не бросает: итог пишется после того, как линия
 * уже свободна.
 *
 * Память (язык, касание) — в общее досье всегда. Настоящий входящий (правка 5)
 * дальше копится по каналу (см. InboundConsultantCall) и доводится до карточки и
 * раздачи, когда станция закончит звонок.
 */
export async function finishConsultantCall(state: ConsultantCallState, result: LiveVoiceScenarioResult): Promise<void> {
  try {
    if (state.contactProfileId && result.clientSpoke) {
      // Язык в досье — только по репликам на нормальной кириллице (10.10.2026): мусорную
      // латиницу расшифровки Live определитель считал таджикским, и русскоговорящий
      // получал в досье «tg», а со следующего звонка — таджикское приветствие.
      const clientText = reliableCallerText(result.transcript);
      await recordContactTurn({
        profileId: state.contactProfileId,
        language: clientText ? detectClientLanguage(clientText) : "unknown",
        conversationId: null,
      });
    }
  } catch (err) {
    void logSystemError("telephony", `Консультант: итог звонка ${state.channelId} не записан: ${describeError(err)}`);
  }
  if (state.direction === "inbound" && state.incomingCallId) {
    await collectInboundPart(state, result);
  } else if (state.direction === "inbound") {
    // Строки журнала на момент начала сессии не было (её пишут параллельно со звонком),
    // а канал станция уже ведёт: без отчёта конец звонка зря ждёт итог сессии, который
    // никто не пришлёт (третий аудит, п.20). Карточку заведёт сам конец звонка.
    // Обещание звонка и того, кого назвали, — всё же в память звонка (P0-2): иначе
    // итог по концу звонка не узнал бы, что человеку обещан звонок.
    rememberPromise(inboundCall(state.channelId), state, result);
    await noteConsultantSession(state.channelId, {
      spoke: result.clientSpoke || !!result.transferred,
      handedBack: !result.transferred && robotHandedCallBack(result.reason),
      // Робот не сказал ни слова — звонок пропущенный, а не «отвечен ИИ» (п.3 аудита 09.10).
      botSpoke: result.transferred ? true : result.botSpoke,
    }).catch((err) => logSystemError("telephony", `Консультант: итог сессии ${state.channelId} не передан станции: ${describeError(err)}`));
  }
}

// ---------------------------------------------------------------------------
// Настоящий входящий: разговор консультанта → карточка и раздача (правка 5)
// ---------------------------------------------------------------------------

/**
 * ОДИН ЗВОНОК — НЕСКОЛЬКО СЕССИЙ. Консультант мог соединить с агентом, агент не
 * взял, и звонок вернулся (royalhome-agent-route → Stasis …,returned): это вторая
 * сессия на том же канале. Разговор для карточки и для разбора лида — обе части
 * вместе, иначе ИИ, решающий «покупатель или продавец», услышал бы только «агент
 * сейчас не может, чем ещё помочь?».
 *
 * Итог доводится, когда известны обе половины: разговор (конец сессии, после
 * заливки записи) и строка журнала со своей записью в хронологии (конец звонка на
 * станции, lib/telephony/incomingCalls.ts → setConsultantCallEndedHook). Порядок
 * их прихода не гарантирован.
 */
interface InboundConsultantCall {
  parts: { transcript: string[]; recordingKey: string | null; transferred: boolean; spoke: boolean }[];
  discussed: Set<number>;
  /** Объект, который консультант узнал в разговоре (последний) — см. PropertyCallMemory. */
  identifiedPropertyId: string | null;
  /** Агент, которого консультант назвал человеку (ведёт объект) — ему задача
   *  «перезвонить» (Б7, consultantCallbackTarget.ts). */
  namedAgentId: string | null;
  summary: string | null;
  callerName: string | null;
  /** Робот на старте звонка был в рабочем окне (ConsultantCallState.promisedSoon). */
  promisedSoon: boolean;
  /** Номер, на который человек сам попросил перезвонить (save_contact phone), —
   *  до 02.10.2026 он оставался в памяти звонка и в карточку не попадал. */
  otherPhone: string | null;
  ended: ConsultantCallEnded | null;
  finalized: boolean;
  touchedAt: number;
  /** Сколько раз доведение итога уже упало (LIVE04): повторы ограничены. */
  finalizeFailures?: number;
  /** Заметка и расшифровка уже легли в запись звонка: повтор их не дописывает вторым разом. */
  notesSaved?: boolean;
  /** Человеку обещан звонок агента (P0-2) — итог обязан поставить задачу исполнителю. */
  callbackPromised?: boolean;
  /** Человек жаловался, что ему не перезвонили (P1-8) — руководству пуш. */
  complained?: boolean;
  /** Договорённости робота (liveVoiceClientTools.ts, 09.10.2026): условия звонящего,
   *  перезвон на выбранное им время, показ — записанный или переданный агенту. */
  agreements?: CallAgreements;
}

/** Что робот договорил в звонке — переносится из сессии в итог звонка. */
export interface CallAgreements {
  request: PropertyCallMemory["request"];
  callbackAt: Date | null;
  callbackTopic: string | null;
  showingWish: PropertyCallMemory["showingWish"];
  bookedShowing: PropertyCallMemory["bookedShowing"];
}

export function agreementsFromMemory(memory: PropertyCallMemory, prev?: CallAgreements): CallAgreements {
  return {
    request: memory.request ?? prev?.request ?? null,
    callbackAt: memory.callbackAt ?? prev?.callbackAt ?? null,
    callbackTopic: memory.callbackTopic ?? prev?.callbackTopic ?? null,
    showingWish: memory.showingWish ?? prev?.showingWish ?? null,
    bookedShowing: memory.bookedShowing ?? prev?.bookedShowing ?? null,
  };
}

/** «10.10 в 15:00» по Душанбе — для агента. */
function agentWhen(at: Date): string {
  const w = dushanbeWallClock(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(w.getUTCDate())}.${p(w.getUTCMonth() + 1)} в ${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`;
}

/**
 * ДОГОВОРЁННОСТИ РОБОТА СТРОКОЙ ДЛЯ АГЕНТА — в запись звонка и в задачу: что ищет
 * (структурно), когда перезвонить, какой показ записан или ждёт подтверждения.
 */
export function agreementsText(a: CallAgreements | undefined): string {
  if (!a) return "";
  const wants = a.request ? clientRequestText(a.request) : "";
  return [
    wants ? `Условия: ${wants}.` : "",
    a.bookedShowing ? `Робот записал показ: объект №${a.bookedShowing.shortId}, ${agentWhen(a.bookedShowing.at)}.` : "",
    a.showingWish ? `Хочет показ: объект №${a.showingWish.shortId}, ${agentWhen(a.showingWish.at)} — подтвердите время.` : "",
    a.callbackAt ? `Просил перезвонить ${agentWhen(a.callbackAt)}${a.callbackTopic ? ` (${a.callbackTopic})` : ""}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Обещание звонка и жалоба — из состояния сессии и её расшифровки в память звонка. */
function rememberPromise(call: InboundConsultantCall, state: ConsultantCallState, result: LiveVoiceScenarioResult): void {
  if (state.callbackPromised || callbackPromisedInTranscript(result.transcript)) call.callbackPromised = true;
  // Плохая слышимость (10.10.2026, liveVoicePoorLine.ts): робот дважды не разобрал речь и
  // ушёл на перезвон — задача «перезвонить» с пометкой о линии и языке.
  const poorLine = poorLineCallbackNote(result.transcript);
  if (poorLine) {
    call.callbackPromised = true;
    const base = state.summary ?? call.summary;
    if (!base?.includes(poorLine)) state.summary = base ? `${base}; ${poorLine}` : poorLine;
  }
  if (noContactComplaintInTranscript(result.transcript)) call.complained = true;
  if (state.properties.namedAgentId) call.namedAgentId = state.properties.namedAgentId;
  if (state.summary) call.summary = state.summary;
  if (state.name) call.callerName = state.name;
  if (state.promisedSoon) call.promisedSoon = true;
  call.agreements = agreementsFromMemory(state.properties, call.agreements);
  if (call.agreements.callbackAt || call.agreements.showingWish) call.callbackPromised = true;
}
const inboundCalls = new Map<string, InboundConsultantCall>();
/** Итог консультанта при временном сбое доводится заново: пауза и число попыток (LIVE04). */
export const INBOUND_FINALIZE_RETRY_MS = 60_000;
const INBOUND_FINALIZE_MAX_FAILURES = 3;
/** Сколько ждать конец сессии после конца звонка: запись заливается в R2 после
 *  отбоя, обычно секунды. Не дождались — доводим с тем, что есть. */
const SESSION_AFTER_END_WAIT_MS = 90_000;
/** Звонок, конца которого станция так и не прислала (рестарт CRM посреди звонка),
 *  не держим в памяти вечно. Ночной подбор autoLeadFromCall подберёт его сам. */
const INBOUND_CALL_TTL_MS = 6 * 60 * 60_000;

function inboundCall(channelId: string): InboundConsultantCall {
  const now = Date.now();
  for (const [id, call] of inboundCalls) if (now - call.touchedAt > INBOUND_CALL_TTL_MS) inboundCalls.delete(id);
  let call = inboundCalls.get(channelId);
  if (!call) {
    call = {
      parts: [],
      discussed: new Set(),
      identifiedPropertyId: null,
      namedAgentId: null,
      summary: null,
      callerName: null,
      promisedSoon: false,
      otherPhone: null,
      ended: null,
      finalized: false,
      touchedAt: now,
    };
    inboundCalls.set(channelId, call);
  }
  call.touchedAt = now;
  return call;
}

async function collectInboundPart(state: ConsultantCallState, result: LiveVoiceScenarioResult): Promise<void> {
  const call = inboundCall(state.channelId);
  const spoke = result.clientSpoke || !!result.transferred;
  call.parts.push({
    transcript: result.transcript,
    recordingKey: result.recordingKey ?? null,
    transferred: !!result.transferred,
    spoke,
  });
  for (const id of state.properties.discussedShortIds) call.discussed.add(id);
  if (state.properties.identifiedPropertyId) call.identifiedPropertyId = state.properties.identifiedPropertyId;
  if (state.properties.namedAgentId) call.namedAgentId = state.properties.namedAgentId;
  // Журнал входящих узнаёт итог сессии (incomingCalls.ts): заговорил ли звонящий —
  // от этого зависит, заводить ли карточку и лид; отдал ли робот звонок станции
  // после сбоя — такой звонок пропущен, а не отвечен (Б6, Б12).
  await noteConsultantSession(state.channelId, {
    spoke,
    handedBack: !result.transferred && robotHandedCallBack(result.reason),
    // Робот не сказал ни слова — звонок пропущенный, а не «отвечен ИИ» (п.3 аудита 09.10).
    botSpoke: result.transferred ? true : result.botSpoke,
  });
  if (state.summary) call.summary = state.summary;
  if (state.name) call.callerName = state.name;
  if (state.otherPhone) call.otherPhone = state.otherPhone;
  if (state.promisedSoon) call.promisedSoon = true;
  rememberPromise(call, state, result);
  if (result.transferred) {
    // Агент сейчас слушает гудки — что было до него, он видит в карточке сразу.
    await noteBeforeTransfer(state.channelId, call, result);
    // Станция уже записала звонок пропущенным (агент по-настоящему не взял, см.
    // ConsultantCallEnded.missed), а итог сессии опоздал — доводим разговор до лида здесь.
    if (call.ended?.missed) await finalizeInboundCall(state.channelId);
    return;
  }
  if (call.ended) await finalizeInboundCall(state.channelId);
}

/**
 * Сессия кончилась так, что мост отдал звонок станции (на автоответчик): сбой на нашей
 * стороне или молчащий звонящий. Перечень — ОДИН, в мосте (handsCallerBackToDialplan,
 * liveVoiceBridge.ts): до 09.10.2026 здесь лежала его копия, и новые причины
 * (gemini_stalled, no_bot_audio_suspected) расходились бы молча. Такой звонок не
 * «отвечен консультантом».
 */
export function robotHandedCallBack(reason: string): boolean {
  return handsCallerBackToDialplan(reason);
}

/** Регистрируется в src/index.ts: станция закончила звонок, который брал консультант. */
export function onConsultantCallEnded(ended: ConsultantCallEnded): void {
  const call = inboundCall(ended.channelId);
  call.ended = ended;
  // Трубку после консультанта взял агент: его разговор идёт обычным путём (запись
  // станции → расшифровка → разбор), а часть консультанта уже в карточке.
  //
  // ПРОПУЩЕННЫЙ, НО СОДЕРЖАТЕЛЬНЫЙ (третий аудит робота 02.10.2026, п.1 и 3): робот отдал
  // звонок станции после сбоя (gemini_closed, рестарт) либо агент после перевода не взял
  // по-настоящему. Звонящий успел рассказать — расшифровка и лид не должны пропасть
  // вместе со сбоем; «пропущенный» (задача и пуш) уже поставлен, их оставляем. Молчал —
  // как раньше, не трогаем: такой звонок может уйти на автоответчик и заговорить там.
  const spokeBefore = call.parts.some((p) => p.spoke);
  if (!ended.byConsultant && !(ended.missed && (spokeBefore || ended.spoke))) {
    inboundCalls.delete(ended.channelId);
    return;
  }
  const last = call.parts[call.parts.length - 1];
  // Последняя сессия уже отчиталась (и это не перевод, после которого звонок ушёл
  // агенту) — доводим сразу; иначе ждём её итога, но не вечно. Перевод, после которого
  // звонок записан пропущенным, агенту не ушёл — ждать итога нечего.
  if (last && (!last.transferred || ended.missed)) {
    void finalizeInboundCall(ended.channelId);
    return;
  }
  setTimeout(() => void finalizeInboundCall(ended.channelId), SESSION_AFTER_END_WAIT_MS).unref?.();
}

/** Расшифровка для карточки и для разбора: «Бот» в ней — консультант агентства. */
/** Хоть в одной части звонка реплики клиента записаны мусором (liveTranscriptUnreliable). */
function transcriptUnreliable(call: InboundConsultantCall): boolean {
  return call.parts.some((part) => liveTranscriptUnreliable(part.transcript));
}

function transcriptText(call: InboundConsultantCall): string {
  return call.parts
    .map((part) => part.transcript.map((line) => line.replace(/^Бот:/, "Консультант:")).join("\n"))
    .filter(Boolean)
    .join("\n— звонок вернулся от агента —\n");
}

/** Приметами, а не номерами: агент номер не помнит (describeDiscussedProperties). */
async function discussedText(call: InboundConsultantCall): Promise<string> {
  const described = await describeDiscussedProperties([...call.discussed]);
  return described.length ? `Обсуждали: ${described.join("; ")}.` : "";
}

async function noteBeforeTransfer(channelId: string, call: InboundConsultantCall, result: LiveVoiceScenarioResult): Promise<void> {
  try {
    const incoming = await prisma.incomingCall.findUnique({ where: { channelId }, select: { clientId: true } });
    if (!incoming?.clientId) return;
    const client = await prisma.client.findUnique({ where: { id: incoming.clientId }, select: { assignedAgentId: true } });
    // Номер для связи — в карточку сразу: если агент возьмёт трубку, итога
    // консультанта (finalizeInboundCall) не будет вовсе.
    const phoneNote = call.otherPhone ? callbackPhoneNote(await saveCallbackPhone(incoming.clientId, call.otherPhone)) : "";
    await logTimeline({
      clientId: incoming.clientId,
      actor: { kind: "system", source: "live-voice-consultant", subjectAgentId: client?.assignedAgentId ?? null },
      type: "SYSTEM",
      notes: ["Консультант (ИИ) поговорил и соединил с агентом.", call.summary ? `Суть: ${call.summary}` : "", agreementsText(call.agreements), phoneNote, await discussedText(call)]
        .filter(Boolean)
        .join(" "),
      transcript: result.transcript.map((line) => line.replace(/^Бот:/, "Консультант:")).join("\n") || null,
      recordingUrl: result.recordingKey ?? null,
    });
  } catch (err) {
    void logSystemError("telephony", `Консультант: запись о переводе звонка ${channelId} не легла в карточку: ${describeError(err)}`);
  }
}

/**
 * Звонок закончился, трубку брал только консультант. Однократно: разговор — в
 * запись звонка, звонок — в разбор (тот же, что у звонка оператору и
 * автоответчика), своему клиенту — задача агенту перезвонить и пуш с сутью.
 */
export async function finalizeInboundCall(channelId: string): Promise<void> {
  const call = inboundCalls.get(channelId);
  if (!call || call.finalized || !call.ended) return;
  call.finalized = true;
  inboundCalls.delete(channelId);
  const { callId, interactionId } = call.ended;
  try {
    // ЗВОНЯЩИЙ НЕ СКАЗАЛ НИ СЛОВА (сбросил через секунду, молчал): ни лида, ни
    // «перезвоните» (02.10.2026, «Всегда первым» брал каждый звонок). Звонок помечается
    // разобранным, чтобы ночной подбор не завёл по нему карточку по номеру.
    // Итог сессии не пришёл вовсе (parts пуст): говорил ли человек, знает только станция
    // (ended.spoke); без слов и короче CONSULTANT_CARD_MIN_SECONDS — тот же «сброс через
    // секунду», а не повод заводить карточку по номеру разбором (третий аудит, п.10).
    const unheard =
      call.parts.length > 0
        ? !call.parts.some((p) => p.spoke)
        : !call.ended.spoke && (call.ended.talkSeconds ?? 0) < CONSULTANT_CARD_MIN_SECONDS;
    if (unheard) {
      if (callId) {
        await prisma.incomingCall.updateMany({
          where: { id: callId, autoLeadAt: null },
          data: { autoLeadAt: new Date(), autoLeadStatus: "skipped" },
        });
      }
      return;
    }
    const transcript = transcriptText(call);
    const recordingKey = call.parts.find((p) => p.recordingKey)?.recordingKey ?? null;
    if (interactionId && !call.notesSaved) {
      const current = await prisma.interaction.findUnique({ where: { id: interactionId }, select: { notes: true } });
      await prisma.interaction.update({
        where: { id: interactionId },
        data: {
          notes: [
            current?.notes ?? "",
            call.summary ? `Суть: ${call.summary}` : "",
            agreementsText(call.agreements),
            await discussedText(call),
            // Итог звонка не должен строиться на мусорной расшифровке как на факте (10.10.2026).
            transcriptUnreliable(call) ? LIVE_TRANSCRIPT_UNRELIABLE_NOTE : "",
          ]
            .filter(Boolean)
            .join(" "),
          ...(transcript ? { transcript } : {}),
          ...(recordingKey ? { recordingUrl: recordingKey } : {}),
        },
      });
      call.notesSaved = true;
    }
    if (!callId) return;
    // missed: звонок записан пропущенным (answered=false), а разговор с роботом был —
    // разбор его всё равно делаем (ignoreAnswered), иначе «не отвечен» отрежет лид.
    const outcome = await autoLeadFromIncomingCall(callId, {
      propertyId: call.identifiedPropertyId,
      ignoreAnswered: !!call.ended.missed,
    });
    // Номер, на который человек попросил перезвонить, — в запасные номера той
    // карточки, к которой привёл разбор (своя, новая или найденная по номеру).
    if (call.otherPhone && outcome.clientId) {
      const saved = await saveCallbackPhone(outcome.clientId, call.otherPhone);
      if (interactionId) await appendInteractionNote(interactionId, callbackPhoneNote(saved));
    }
    // В раздачу ушёл лид — агенту напишет раздача. Свой клиент в раздачу не идёт:
    // ему перезванивает его агент, и знать он должен, о чём человек говорил.
    // Пропущенный: задача «перезвонить» и пуш агенту уже поставлены finishIncomingCall —
    // второй задачи на того же клиента не заводим.
    if (outcome.status === "known_client" && outcome.clientId && !call.ended.missed) {
      await askAgentToCallBack(outcome.clientId, interactionId, call);
    } else if (call.callbackPromised && !call.ended.missed) {
      await keepCallbackPromise(outcome, interactionId, call);
    }
    if (call.complained) await raiseNoContactComplaint(outcome.clientId, call);
  } catch (err) {
    void logSystemError("telephony", `Консультант: итог входящего ${channelId} не доведён до карточки: ${describeError(err)}`);
    // Запись стёрта выше ДО записи в базу, и повторять было нечем (LIVE04): возвращаем её
    // и доводим по таймеру, ограниченное число раз. Шаги, уже сделанные, не повторяются
    // (notesSaved; разбор звонка и задача «перезвонить» сами не заводят второго).
    call.finalizeFailures = (call.finalizeFailures ?? 0) + 1;
    if (call.finalizeFailures < INBOUND_FINALIZE_MAX_FAILURES) {
      call.finalized = false;
      call.touchedAt = Date.now();
      inboundCalls.set(channelId, call);
      setTimeout(() => void finalizeInboundCall(channelId), INBOUND_FINALIZE_RETRY_MS).unref?.();
    }
  }
}

/**
 * НОМЕР ДЛЯ СВЯЗИ, КОТОРЫЙ ЧЕЛОВЕК ПРОДИКТОВАЛ САМ (02.10.2026, аудит надёжности).
 *
 * Тем же путём, что второй номер в переписке (messengers/conversation.ts) и при
 * приёме заявки (services/leads/intake.ts): в Client.extraPhones через
 * pickFreeExtraPhones — номер, уже записанный за другой карточкой, не
 * дописывается (один номер — один хозяин, lib/clientPhones.ts). Сами цифры в
 * заметку не пишутся: заметку читают и без права видеть номера, а номер виден в
 * карточке тем, кому положено.
 */
export type CallbackPhoneSaved = "added" | "already" | "taken" | "unparsed";

export async function saveCallbackPhone(clientId: string, spoken: string): Promise<CallbackPhoneSaved> {
  const phones = extractAllPhones(spoken);
  if (phones.length === 0) return "unparsed";
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { phone: true, whatsappPhone: true, extraPhones: true, deletedAt: true },
  });
  if (!client || client.deletedAt) return "unparsed";
  if (dedupePhones(phones, [client.phone, client.whatsappPhone, ...client.extraPhones]).length === 0) return "already";
  const fresh = await pickFreeExtraPhones(phones, {
    clientId,
    phone: client.phone,
    whatsappPhone: client.whatsappPhone,
    existing: client.extraPhones,
  });
  if (fresh.length === 0) return "taken";
  await prisma.client.update({
    where: { id: clientId },
    data: { extraPhones: { set: [...new Set([...client.extraPhones, ...fresh])] } },
  });
  return "added";
}

function callbackPhoneNote(saved: CallbackPhoneSaved): string {
  switch (saved) {
    case "added":
      return "Просил перезвонить на другой номер — он записан в карточку запасным.";
    case "already":
      return "Просил перезвонить на другой свой номер — он уже есть в карточке.";
    case "taken":
      return "Продиктовал другой номер для связи, но он записан за другой карточкой — номер слышен в записи разговора.";
    case "unparsed":
      return "Продиктовал другой номер для связи, но разобрать его не удалось — номер слышен в записи разговора.";
  }
}

async function appendInteractionNote(interactionId: string, note: string): Promise<void> {
  const current = await prisma.interaction.findUnique({ where: { id: interactionId }, select: { notes: true } });
  await prisma.interaction.update({
    where: { id: interactionId },
    data: { notes: [current?.notes ?? "", note].filter(Boolean).join(" ") },
  });
}

/**
 * ОБЕЩАНИЕ «АГЕНТ НАБЕРЁТ» НЕЗНАКОМЦУ — С ИСПОЛНИТЕЛЕМ (09.10.2026, аудит P0-2).
 *
 * Своему клиенту задачу ставит askAgentToCallBack по `known_client`. Незнакомцу звонок
 * гарантировала только раздача лида — а при исходах «модель не уверена» (обычное дело
 * на плохой линии), «Другое» без агента или при выключенной раздаче лида нет ни у кого,
 * хотя звонок прозвучал вслух. Здесь:
 *  - лид ушёл агенту (`qualified` и у карточки есть агент) — исполнитель есть, раздача
 *    сама скажет агенту; второй задачи не заводим;
 *  - соискатель (`candidate`) — его ведёт HR через анкету; `irrelevant` (сотрудник,
 *    служебный номер, «не по делу») — звонка никто не ждёт;
 *  - иначе — задача «перезвонить» той же функцией, что своему клиенту: агенту, которого
 *    робот назвал, иначе дежурному, иначе руководству (consultantCallbackTarget.ts).
 *    Владелец карточки при этом НЕ назначается: задача — не передача клиента, закон о
 *    владении (docs/law) решает раздача, а не робот;
 *  - карточки нет вовсе (автосоздание выключено) — пуш тому же адресату со ссылкой на
 *    «Звонки»: задачу повесить некуда, но человек о звонке узнает.
 */
async function keepCallbackPromise(
  outcome: { status: string; clientId: string | null },
  interactionId: string | null,
  call: InboundConsultantCall
): Promise<void> {
  if (outcome.status === "candidate" || outcome.status === "irrelevant" || outcome.status === "known_client") return;
  if (outcome.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: outcome.clientId },
      select: { assignedAgent: { select: { isActive: true, frozenAt: true } } },
    });
    const owner = client?.assignedAgent;
    // Лид ушёл агенту — раздача сама ему скажет. Но время, которое человек выбрал сам
    // (перезвон, показ на подтверждение), раздача не знает: тогда задача всё равно.
    const timeBound = !!(call.agreements?.callbackAt || call.agreements?.showingWish);
    if (outcome.status === "qualified" && owner?.isActive && !owner.frozenAt && !timeBound) return;
    await askAgentToCallBack(outcome.clientId, interactionId, call, { stranger: !owner });
    return;
  }
  const target = await pickCallbackAgent({ namedAgentId: call.namedAgentId, assignedAgentId: null });
  const due = await callbackDue(call, target.agentDaysOff);
  if (due.deferredToMorning) return;
  const payload = {
    title: "📞 Консультант обещал звонок — карточки нет, перезвоните",
    body: [`${call.callerName ?? "Звонящий"}: ${call.summary ?? "послушайте разговор в «Звонках»"}`, agreementsText(call.agreements)].filter(Boolean).join(" "),
    url: "/calls",
    tag: `consultant-callback-nocard-${call.ended?.callId ?? "call"}`,
  };
  const recipients = target.agentId ? [target.agentId] : target.supervisorIds;
  await Promise.all(
    recipients.map((agentId) =>
      sendPushToAgent(agentId, payload).catch((err) => logSystemError("telephony", `Пуш об обещанном звонке не ушёл: ${describeError(err)}`))
    )
  );
}

/**
 * «МНЕ ОБЕЩАЛИ ПЕРЕЗВОНИТЬ — НИКТО НЕ ПОЗВОНИЛ» (09.10.2026, аудит P1-8). У чат-бота такую
 * жалобу поднимает руководителю complaintGuard; у робота её не видел никто, а промт
 * велел снова пообещать звонок. Тем же распознавателем — пуш тем, кто раздаёт клиентов.
 */
async function raiseNoContactComplaint(clientId: string | null, call: InboundConsultantCall): Promise<void> {
  try {
    const client = clientId ? await prisma.client.findUnique({ where: { id: clientId }, select: { shortId: true, fullName: true } }) : null;
    const supervisors = await findAgentsWithPermission("clients.assign");
    const working = supervisors.length
      ? await prisma.agent.findMany({ where: { id: { in: supervisors }, isActive: true, frozenAt: null }, select: { id: true } })
      : [];
    const payload = {
      title: "⚠️ Жалоба по телефону: обещали перезвонить и не перезвонили",
      body: `${call.callerName ?? client?.fullName ?? "Звонящий"}: ${call.summary ?? "послушайте разговор с консультантом"}`,
      url: client ? `/clients/${client.shortId}` : "/calls",
      tag: `consultant-complaint-${clientId ?? call.ended?.callId ?? "call"}`,
    };
    await Promise.all(
      working.map((a) =>
        sendPushToAgent(a.id, payload).catch((err) => logSystemError("telephony", `Пуш о жалобе после консультанта не ушёл: ${describeError(err)}`))
      )
    );
  } catch (err) {
    void logSystemError("telephony", `Консультант: жалоба «не перезвонили» не передана руководству: ${describeError(err)}`);
  }
}

/**
 * КОГДА ПЕРЕЗВОНИТЬ. Человек сам выбрал время (request_callback, 09.10.2026) — задача
 * ровно на него: робот вслух назвал это время. Иначе — как раньше (callbackDueAt).
 */
async function callbackDue(call: InboundConsultantCall, agentDaysOff: readonly number[]): Promise<{ at: Date; deferredToMorning: boolean }> {
  const chosen = call.agreements?.callbackAt;
  if (chosen && chosen.getTime() > Date.now()) return { at: chosen, deferredToMorning: false };
  // Срок — на рабочий день АДРЕСАТА задачи (11.10.2026): у агента выходной — его утро.
  return callbackDueAt(new Date(), { promisedSoon: call.promisedSoon, agentDaysOff });
}

async function askAgentToCallBack(
  clientId: string,
  interactionId: string | null,
  call: InboundConsultantCall,
  /** Новый звонящий (у карточки нет агента): «ваш клиент» и «вместо ответственного» неправда. */
  opts: { stranger?: boolean } = {}
): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { shortId: true, fullName: true, assignedAgentId: true },
  });
  if (!client) return;
  // КОМУ: агенту, которого робот назвал (ведёт объект), иначе тому, кто ведёт клиента;
  // уволенному и замороженному — никогда: дежурному, а нет дежурного — руководству
  // (consultantCallbackTarget.ts, Б7/Б8). Раньше без агента клиента задачи не было
  // вовсе, а замороженному агенту она уходила молча.
  // Личный выходной агента (11.10.2026) адресата не меняет: задача ему же, срок — на его
  // рабочий день (callbackDue ниже). Закрепление не меняется.
  const target = await pickCallbackAgent({ namedAgentId: call.namedAgentId, assignedAgentId: client.assignedAgentId });
  // КОГДА: время, которое человек выбрал сам (request_callback); иначе ночью робот
  // сказал «утром» — задача на начало рабочего дня, без ночного пуша (Б9).
  const due = await callbackDue(call, target.agentDaysOff);
  const reroute = opts.stranger
    ? " Новый звонящий: консультант обещал звонок агента, а лид ещё никому не ушёл."
    : target.source === "named" && client.assignedAgentId !== target.agentId
      ? " Звонок обещан агентом объекта, который назвал консультант."
      : target.source === "duty" || target.source === "management"
        ? " Ответственный за клиента сейчас не работает — перезвоните вместо него."
        : "";
  const deal = agreementsText(call.agreements);
  const nextAction =
    (call.agreements?.showingWish ? "Подтвердить показ и перезвонить" : "Перезвонить") +
    `: клиент говорил с консультантом${call.summary ? ` — ${call.summary.slice(0, 160)}` : ""}` +
    (deal ? ` ${deal.slice(0, 400)}` : "") +
    (call.otherPhone ? " (просил на другой номер — см. запасные в карточке)" : "") +
    reroute +
    (transcriptUnreliable(call) ? ` ${LIVE_TRANSCRIPT_UNRELIABLE_NOTE}` : "");
  const nextActionDate = due.at;
  // Одна открытая задача «перезвонить» на клиента (lib/autoTasks.ts): уже есть —
  // продлевается она, а не заводится вторая.
  const slot = await claimAutoTaskSlot(clientId, "consultant_callback", nextAction, nextActionDate);
  // Адресат задачи — subjectAgentId записи (null — общая задача руководства).
  const taskId = slot.assignToNewRecord ? interactionId : (slot.existingInteractionId ?? null);
  if (slot.assignToNewRecord && interactionId) {
    await prisma.interaction.update({
      where: { id: interactionId },
      data: { nextAction, nextActionDate, autoTaskKind: "consultant_callback", subjectAgentId: target.agentId },
    });
  } else if (slot.assignToNewRecord) {
    // Записи звонка в карточке нет (карточку завёл только разбор после звонка, P0-2):
    // задача ложится своей записью, а не теряется вместе с отсутствующей записью звонка.
    await logTimeline({
      clientId,
      actor: {
        kind: "system",
        source: "live-voice-consultant",
        subjectAgentId: target.agentId,
        ...(target.agentId ? {} : { sharedTask: true as const }),
      },
      type: "SYSTEM",
      notes: "Консультант (ИИ) обещал звонок агента.",
      nextAction,
      nextActionDate,
      autoTaskKind: "consultant_callback",
    });
  } else if (taskId) {
    await prisma.interaction.update({ where: { id: taskId }, data: { subjectAgentId: target.agentId } });
  }
  // Ночью — без пуша: он разбудил бы человека ради задачи на утро (задача лежит в его
  // списке с началом рабочего дня).
  if (due.deferredToMorning) return;
  const who = call.callerName ?? client.fullName;
  const said = call.summary ?? "послушайте разговор в карточке";
  const payload = {
    // Не тот, чей клиент, а дежурный вместо него — «Ваш клиент» было бы неправдой
    // (третий аудит, п.20).
    title: opts.stranger
      ? "📞 Консультант обещал звонок новому звонящему — перезвоните"
      : target.source === "duty"
        ? "📞 Клиент говорил с консультантом — перезвоните вместо ответственного"
        : "📞 Ваш клиент звонил, ответил консультант",
    body: `${who}: ${said}`,
    url: `/clients/${client.shortId}`,
    tag: `consultant-callback-${clientId}`,
  };
  const recipients = target.agentId ? [target.agentId] : target.supervisorIds;
  const pushes = recipients.map((agentId) =>
    sendPushToAgent(agentId, target.agentId ? payload : { ...payload, title: "📞 Клиенту обещан звонок, а ответственного нет" }).catch((err) =>
      logSystemError("telephony", `Пуш агенту после консультанта не ушёл: ${describeError(err)}`)
    )
  );
  await Promise.all(pushes);
}

/** Только для тестов. */
export function resetInboundConsultantCalls(): void {
  inboundCalls.clear();
}
