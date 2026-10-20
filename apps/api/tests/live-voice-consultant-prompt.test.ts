import { describe, expect, it } from "vitest";
import { MANDATORY_BOT_RULES } from "../src/ai/dushanbeGeography.js";
import { INSPECTION_CHECKLIST_BLOCK } from "../src/ai/inspectionChecklist.js";
import { LEGAL_FAQ_BLOCK } from "../src/ai/legalFaq.js";
import { callbackPromise } from "../src/ai/agencyFacts.js";
import { buildConsultantSystemPrompt, type ConsultantCaller } from "../src/ai/liveVoiceConsultantPersona.js";
import { buildLiveVoiceKnowledge, VOICE_SELLER_INTAKE } from "../src/ai/liveVoiceKnowledge.js";
import {
  buildLiveVoiceSystemPrompt,
  DEFAULT_LIVE_VOICE_PROMPT,
  LIVE_VOICE_IDENTITY_RULES,
  LIVE_VOICE_SPEECH_RULES,
} from "../src/ai/liveVoicePersona.js";
import { SALES_FACTS, buildSellerRules } from "../src/ai/salesPlaybook.js";
import { SELLER_INTAKE_RULES } from "../src/ai/sellerIntake.js";

/**
 * Консультант на входящих (24.09.2026): знания общие с чат-ботом, роль своя.
 * Чистые функции, без базы и без сети.
 */

const wall = new Date(Date.UTC(2026, 8, 24, 10, 30));
const knowledge = buildLiveVoiceKnowledge({
  folkGeography: "\n<карта>Профсоюз — Сино</карта>",
  sellerRules: "\n<про_нас>ЧЕМ МЫ НЕ ЗАНИМАЕМСЯ: Земля</про_нас>",
  learnedRules: "\nВЫВОДЫ: не обещать рассрочку",
  usdToTjs: 10.95,
  wallClock: wall,
});

const stranger: ConsultantCaller = { numberKnown: true, selfName: null, agentName: null, dossier: "" };

describe("справочник голоса — те же блоки, что у чат-бота", () => {
  it("условия работы, обязательные правила, юридическая справка и осмотр — сами константы чат-бота, не копии", () => {
    for (const block of [SALES_FACTS, MANDATORY_BOT_RULES, LEGAL_FAQ_BLOCK, INSPECTION_CHECKLIST_BLOCK]) {
      expect(knowledge).toContain(block);
    }
  });

  it("то, что читается из базы, печатается как пришло: карта мест, «про нас», выученное, курс, время", () => {
    expect(knowledge).toContain("Профсоюз — Сино");
    expect(knowledge).toContain("ЧЕМ МЫ НЕ ЗАНИМАЕМСЯ: Земля");
    expect(knowledge).toContain("не обещать рассрочку");
    expect(knowledge).toContain("1 USD = 10.95 TJS");
    expect(knowledge).toContain("СЕЙЧАС В ДУШАНБЕ");
  });

  it("приём объекта — телефонный, а не «напишите одним сообщением» из переписки", () => {
    expect(knowledge).toContain(VOICE_SELLER_INTAKE);
    expect(knowledge).not.toContain(SELLER_INTAKE_RULES);
  });

  it("курс не прочитался — строки о курсе нет вовсе, а не «1 USD = 0»", () => {
    const out = buildLiveVoiceKnowledge({ folkGeography: "", sellerRules: "", learnedRules: "", usdToTjs: null, wallClock: wall });
    expect(out).not.toContain("КУРС ДОЛЛАРА");
  });

  it("предел вопросов из «Как продавать» голосу не печатается, остальные правила продавца — да", () => {
    const voice = buildSellerRules({ maxQuestions: null, notSelling: "Земля", advantages: "Своя съёмка" });
    expect(voice).not.toContain("СКОЛЬКО ВОПРОСОВ");
    expect(voice).toContain("ЧЕМ МЫ НЕ ЗАНИМАЕМСЯ: Земля");
    expect(voice).toContain("Своя съёмка");
    expect(buildSellerRules({ maxQuestions: 2, notSelling: "", advantages: "" })).toContain("не больше 2");
  });
});

describe("роль консультанта на входящих", () => {
  it("общие правила голоса и честность на прямой вопрос — те же, что у исходящего звонка", () => {
    const prompt = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false });
    expect(prompt).toContain(LIVE_VOICE_SPEECH_RULES);
    expect(prompt).toContain(LIVE_VOICE_IDENTITY_RULES);
    expect(DEFAULT_LIVE_VOICE_PROMPT).toContain(LIVE_VOICE_SPEECH_RULES);
    expect(DEFAULT_LIVE_VOICE_PROMPT).toContain(LIVE_VOICE_IDENTITY_RULES);
    expect(prompt).toContain(knowledge);
  });

  it("номер пришёл со звонком — диктовать его не просит; скрыт — просит", () => {
    const known = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true });
    expect(known).toContain("Диктовать номер НЕ проси");
    const hidden = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, numberKnown: false },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(hidden).toContain("НОМЕР СКРЫТ");
    expect(hidden).not.toContain("Диктовать номер НЕ проси");
  });

  it("имя, которое человек называл сам, — в приветствие; нет имени — не угадывать", () => {
    const named = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, selfName: "Далер" },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(named).toContain("называл себя «Далер»");
    const nameless = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true });
    expect(nameless).toContain("не угадывай его");
  });

  it("клиент нашего агента — по его делам только агент, досье печатается в блоке «кто звонит»", () => {
    const prompt = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, agentName: "Умед", dossier: "\n\nДОСЬЕ СОБЕСЕДНИКА: искал двушку." },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(prompt).toContain("ЕГО ВЕДЁТ АГЕНТ Умед");
    expect(prompt).toMatch(/<кто_звонит>[\s\S]*ДОСЬЕ СОБЕСЕДНИКА: искал двушку\.[\s\S]*<\/кто_звонит>/);
  });

  it("незнакомец без досье — блока «кто звонит» нет вовсе", () => {
    const prompt = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true });
    expect(prompt).not.toContain("<кто_звонит>");
  });

  it("ночью звонок агента «прямо сейчас» не обещается; срок — общее решение с чатом (10.10.2026)", () => {
    const hours = { start: "10:00", end: "22:30" };
    // Суббота 23:30 по Душанбе, общий выходной в воскресенье (Настройки, 11.10.2026):
    // следующий рабочий день — понедельник, а не воскресенье.
    const nightPromise = callbackPromise(new Date("2026-10-10T18:30:00Z"), { ...hours, daysOff: [0] });
    const night = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: false, forceRussianOnly: true, callbackPromise: nightPromise });
    expect(night).toContain("КОГДА ПОЗВОНИТ АГЕНТ: в понедельник после 10:00");
    expect(night).not.toContain("перезвонит утром");
    const dayPromise = callbackPromise(new Date("2026-10-06T07:00:00Z"), hours);
    const day = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true, callbackPromise: dayPromise });
    expect(day).toContain("КОГДА ПОЗВОНИТ АГЕНТ: сегодня");
    expect(day).toContain("«прямо сейчас» и минуты не обещай");
  });

  it("замок на русский — ни таджикских примеров, ни таджикского приветствия, в конце замок", () => {
    const prompt = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true });
    expect(prompt).not.toContain("ПРОИЗНОШЕНИЕ");
    expect(prompt).not.toContain("ассалому алайкум, слушаю");
    expect(prompt).not.toContain("Ассалому алайкум, Royal Home");
    expect(prompt.trimEnd().endsWith("</system_role>")).toBe(true);
    expect(prompt).toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  it("без замка — таджикские примеры, но без приветствия ИСХОДЯЩЕГО звонка («звоним мы»)", () => {
    const prompt = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false });
    expect(prompt).toContain("ПРОИЗНОШЕНИЕ");
    // 10.10.2026: незнакомцу — таджикское слово первым, затем Royal Home и русский.
    expect(prompt).toContain("«Ассалому алайкум! Здравствуйте, Royal Home, слушаю вас»");
    expect(prompt).not.toContain("Аз ширкати Роял Хом занг мезанем");
    expect(prompt).not.toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  // Живая проба 02.10.2026: робот сам позвонил Dan и сказал «вы сами нам позвонили».
  it("звонок набрали мы — консультант знает, что звонил он, а не ему", () => {
    const outbound = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, weCalled: true },
      withinWorkingHours: true,
      forceRussianOnly: false,
    });
    expect(outbound).toContain("Сейчас звонок от агентства: набрали мы");
    expect(outbound).toContain("Никогда не говори ему, что он позвонил сам");
    expect(outbound).not.toContain("человек позвонил нам сам");
    const inbound = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false });
    expect(inbound).toContain("человек позвонил нам сам");
    expect(inbound).not.toContain("Сейчас звонок от агентства");
  });

  // Аудит 02.10.2026, раздел 6: в режиме «набрали мы» промт всё ещё говорил
  // «пойми, зачем человек звонит» и «номер звонящего пришёл со звонком».
  it("набрали мы — ни «зачем человек звонит», ни «номер звонящего»; номер не просит", () => {
    const outbound = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, weCalled: true },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(outbound).toContain("КАК ВЕСТИ РАЗГОВОР. Звонок от нас");
    expect(outbound).not.toContain("зачем человек звонит");
    expect(outbound).not.toContain("НОМЕР ЗВОНЯЩЕГО");
    expect(outbound).not.toContain("Звонить может кто угодно");
    expect(outbound).toContain("НОМЕР ЭТОГО ЧЕЛОВЕКА У НАС ЕСТЬ");
    expect(outbound).toContain("Диктовать номер НЕ проси");
    // Скрытый номер при звонке от нас не бывает: просить номер нельзя и тогда.
    const hidden = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, weCalled: true, numberKnown: false },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(hidden).not.toContain("НОМЕР СКРЫТ");
  });

  // Та же проба: плохая линия превращала русскую речь в «испанский» и «немецкий»,
  // и робот отвечал на них.
  it("других языков, кроме русского и таджикского, нет: чужая речь — помехи, переспросить", () => {
    for (const forceRussianOnly of [true, false]) {
      const prompt = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly });
      expect(prompt).toContain("ЯЗЫК — ТОЛЬКО РУССКИЙ ИЛИ ТАДЖИКСКИЙ");
      expect(prompt).toContain("плохо слышно");
      expect(prompt).toContain("Никогда не говори, на каких языках ты говоришь");
    }
    expect(LIVE_VOICE_SPEECH_RULES).toContain("ЯЗЫК — ТОЛЬКО РУССКИЙ ИЛИ ТАДЖИКСКИЙ");
  });
});

describe("обращения по полу — запрет владельца действует и в голосе", () => {
  it("примеры таджикского больше не разрешают «ака»/«апаҷон» ни консультанту, ни исходящему звонку", () => {
    const consultant = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false });
    const outbound = buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: false });
    for (const prompt of [consultant, outbound]) {
      expect(prompt).not.toContain("«ака», «апаҷон» — тоже нормально");
      expect(prompt).toContain("Обращения по полу");
      expect(prompt).not.toContain("Салому алейкум апаҷон");
    }
  });
});

/**
 * Два языка по языку человека (24.09.2026, Dan: «таджикский и русский, по языку
 * клиента»). Голос выбирается до ответа и на весь звонок, поэтому ошибка здесь —
 * русский акцент у таджикского голоса на всю беседу.
 */
describe("язык и голос консультанта", () => {
  const voices = { liveVoiceVoiceName: "Kore", liveVoiceVoiceNameTajik: "Aoede", liveVoiceForceRussianOnly: false };

  // 02.10.2026: незнакомец (языка нет) — таджикский голос, как и его приветствие
  // «ассалому алейкум» (было: основной, и первое слово звучало с акцентом).
  it("говорил с нами по-таджикски или неизвестно — таджикский голос; по-русски — основной", async () => {
    const { consultantVoiceName } = await import("../src/lib/telephony/liveVoiceConsultant.js");
    expect(consultantVoiceName(voices, "tg")).toBe("Aoede");
    expect(consultantVoiceName(voices, "ru")).toBe("Kore");
    expect(consultantVoiceName(voices, null)).toBe("Aoede");
  });

  it("замок «только русский» — основной голос всегда; таджикский не задан — тоже основной", async () => {
    const { consultantVoiceName } = await import("../src/lib/telephony/liveVoiceConsultant.js");
    expect(consultantVoiceName({ ...voices, liveVoiceForceRussianOnly: true }, "tg")).toBe("Kore");
    expect(consultantVoiceName({ ...voices, liveVoiceVoiceNameTajik: null }, "tg")).toBe("Kore");
  });

  it("здоровается на языке человека, а незнакомцу — на обоих, таджикский первым", () => {
    const say = (language: string | null) =>
      buildConsultantSystemPrompt({ knowledge, caller: { ...stranger, language }, withinWorkingHours: true, forceRussianOnly: false });
    expect(say("tg")).toContain("гӯш мекунам");
    expect(say("ru")).toContain("«Royal Home, здравствуйте, слушаю вас»");
    expect(say("ru")).not.toContain("ассалому алайкум, слушаю");
    // 10.10.2026 (владелец: «таджикский — в приоритете»): выбора «или по-русски» больше нет.
    expect(say(null)).not.toContain("или по-русски «Royal Home, здравствуйте");
    expect(say(null)).toContain("на двух языках, коротко, первое слово по-таджикски");
  });
});

/**
 * Напористость (02.10.2026, владелец: «берёт мой номер и отдаёт агента сразу,
 * нагло») и штампы робота. Промт — единственное, что модель слышит про темп, поэтому
 * проверяются сами формулировки.
 */
describe("консультант не спешит отдать агенту и не звучит роботом", () => {
  const day = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true });
  const night = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: false, forceRussianOnly: true });

  it("соединяет только с согласия, звонок агента обещает один раз, имя агента — один раз", () => {
    expect(day).toContain("СОЕДИНИТЬ С АГЕНТОМ — ТОЛЬКО С СОГЛАСИЯ");
    expect(day).toContain("ПРО ЗВОНОК АГЕНТА — ОДИН РАЗ ЗА РАЗГОВОР");
    expect(day).toContain("СПРАШИВАЙ, А НЕ СООБЩАЙ");
    expect(day).not.toContain("скажи, что агент перезвонит и покажет");
    expect(day).not.toContain("мы передаём всё агенту, и агент перезвонит");
    expect(day).not.toContain("сейчас соединю вас с …, минутку");
  });

  it("обычное прощание — end_call, а не эскалация руководству", () => {
    expect(day).not.toContain("Если человек хочет закончить или ты не справляешься");
    expect(day).toMatch(/обычное прощание и end_call, НЕ escalate_to_human/);
  });

  it("нерабочее время — соединение не предлагается, без казённых «нерабочее время» вслух", () => {
    expect(night).toContain("соединение не предлагай");
    expect(night).not.toContain("СОЕДИНИТЬ С АГЕНТОМ — ТОЛЬКО С СОГЛАСИЯ");
    expect(night).toContain("«все заняты», «к сожалению» не говори");
    // Рабочее время, но звонок вернулся от агента — тоже не предлагать.
    const returned = buildConsultantSystemPrompt({
      knowledge,
      caller: stranger,
      withinWorkingHours: true,
      forceRussianOnly: true,
      transferAvailable: false,
    });
    expect(returned).not.toContain("СОЕДИНИТЬ С АГЕНТОМ — ТОЛЬКО С СОГЛАСИЯ");
  });

  it("свой клиент: по новому вопросу помогает сам, агента не называет без нужды", () => {
    const own = buildConsultantSystemPrompt({
      knowledge,
      caller: { ...stranger, agentName: "Ноза" },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(own).not.toContain("скажи, что передашь Ноза и тот перезвонит");
    expect(own).toContain("агента без нужды не упоминай");
  });

  it("не хочет этого агента — без «все заняты», через руководство", () => {
    expect(day).toContain("ЧЕЛОВЕК НЕ ХОЧЕТ ЭТОГО АГЕНТА");
    expect(day).toContain("просит другого агента вместо");
  });

  it("без пересказа, восторгов, «Чем могу помочь?» и «Так,»; объекты по одному, числа словами", () => {
    expect(LIVE_VOICE_SPEECH_RULES).toContain("НЕ ПЕРЕСКАЗЫВАЙ СКАЗАННОЕ");
    expect(LIVE_VOICE_SPEECH_RULES).toContain("\"Отлично!\"");
    expect(LIVE_VOICE_SPEECH_RULES).toContain("Никогда не говори \"Чем могу помочь?\"");
    expect(LIVE_VOICE_SPEECH_RULES).not.toContain("\"э-э\"");
    expect(LIVE_VOICE_SPEECH_RULES).not.toContain("Начинай реплики иногда со связки — \"Так\"");
    expect(LIVE_VOICE_SPEECH_RULES).toContain("ОБЪЕКТЫ — ПО ОДНОМУ И КОРОТКО");
    expect(LIVE_VOICE_SPEECH_RULES).toContain("шестьдесят два с половиной квадрата");
    expect(day).not.toContain("спроси, чем ещё можешь помочь");
  });

  it("исходящий звонок (набрали мы): номер не просит, прощание не про «агент перезвонит»", () => {
    expect(DEFAULT_LIVE_VOICE_PROMPT).toContain("Диктовать номер НЕ проси никогда");
    expect(DEFAULT_LIVE_VOICE_PROMPT).not.toContain("вежливо возьми номер телефона");
    expect(DEFAULT_LIVE_VOICE_PROMPT).not.toContain("Хорошо, агент вам перезвонит. Всего доброго!");
    expect(DEFAULT_LIVE_VOICE_PROMPT).toContain("НЕ повод для escalate_to_human");
  });
});

/**
 * МАНЕРА РЕЧИ (10.10.2026, владелец: «слышно, что робот: слишком чёткая дикция,
 * интонация роботская»). Проверяются сами формулировки: модель слышит про манеру
 * только промт, а у gemini-3.8-live настроек «живости» в setup нет.
 */
describe("манера речи консультанта — как живой человек", () => {
  const ru = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true });
  const both = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false });

  it("конкретные правила: реакция первой, разные подтверждения, без повтора зачина, «Понимаю» не рефлекс, имя один раз", () => {
    for (const prompt of [ru, both]) {
      expect(prompt).toContain("МАНЕРА РЕЧИ — КАК ЖИВОЙ МЕНЕДЖЕР НА ТЕЛЕФОНЕ");
      expect(prompt).toContain("без «дикторской» чёткости");
      expect(prompt).toContain("Каждый ход начинай с короткой реакции");
      expect(prompt).toContain("Один и тот же зачин в двух ходах подряд не повторяй");
      expect(prompt).toContain("«Понимаю» и «Я вас понимаю» — не рефлекс");
      expect(prompt).toContain("Имя человека вслух — один раз за звонок");
      expect(prompt).toContain("Ход — не больше двух коротких предложений");
      expect(prompt).toContain("Без канцелярита");
    }
  });

  it("подтверждений по-русски — от шести до восьми, и среди них нет запрещённых общими правилами «Так,» и восторгов", () => {
    const line = ru.split("\n").find((l) => l.startsWith("- Подтверждения меняй:")) ?? "";
    const phrases = line.slice(0, line.indexOf(". Один")).match(/«[^»]+»/g) ?? [];
    expect(phrases.length).toBeGreaterThanOrEqual(6);
    expect(phrases.length).toBeLessThanOrEqual(8);
    for (const banned of ["«Так", "«Отлично", "«Прекрасно", "«Понимаю"]) {
      expect(phrases.some((p) => p.startsWith(banned))).toBe(false);
    }
  });

  it("таджикские подтверждения — только без замка; с замком таджикского в блоке манеры нет", () => {
    expect(both).toContain("«Ҳа, фаҳмидам»");
    expect(both).toContain("«Майлаш»");
    expect(ru).not.toContain("«Ҳа, фаҳмидам»");
    const manner = ru.slice(ru.indexOf("МАНЕРА РЕЧИ"), ru.indexOf("КАК БРАТЬ ТРУБКУ"));
    expect(manner).not.toMatch(/[ҲҳҚқҒғҶҷӢӣӮӯ]/);
  });

  it("блок манеры не раздувает промт: меньше 2 600 знаков с таджикской частью", () => {
    const manner = both.slice(both.indexOf("МАНЕРА РЕЧИ"), both.indexOf("КАК БРАТЬ ТРУБКУ"));
    expect(manner.length).toBeGreaterThan(500);
    expect(manner.length).toBeLessThan(2600);
  });
});

/**
 * АУДИТ 09.10.2026 (робот перед первым клиентом): P1-10 — выжимка запретов в самом хвосте
 * промта (Live держит середину длинного промта хуже); P1-8 — жалоба «не перезвонили» не
 * получает нового обещания; P2-3 — аренда собственника, риелтор, грубость, «я сотрудник»;
 * P2-10 — обращения по полу на русском.
 */
describe("аудит 09.10: хвост промта и новые сценарии", () => {
  const caller: ConsultantCaller = { numberKnown: true, selfName: null, agentName: null, dossier: "" };
  const prompt = (forceRussianOnly: boolean) =>
    buildConsultantSystemPrompt({ knowledge: "<справочник>…</справочник>", caller, withinWorkingHours: true, forceRussianOnly });

  it("выжимка запретов — в хвосте: после справочника и досье; с замком за ней идёт только замок", () => {
    for (const lock of [true, false]) {
      const text = prompt(lock);
      const at = text.lastIndexOf("<главное_напоследок>");
      expect(at).toBeGreaterThan(text.lastIndexOf("</справочник>"));
      expect(text.slice(at)).toContain("</главное_напоследок>");
      const after = text.slice(text.lastIndexOf("</главное_напоследок>") + "</главное_напоследок>".length).trim();
      if (lock) expect(after.endsWith("</system_role>")).toBe(true);
      else expect(after).toBe("");
      const tailBlock = text.slice(at);
      expect(tailBlock).toContain("только из ответа search_properties или get_property");
      expect(tailBlock).toContain("Размер скидки не называй");
      expect(tailBlock).toContain("Чужие телефоны");
      expect(tailBlock).toContain("«девушка», «мужчина», «молодой человек»");
    }
  });

  it("жалоба «не перезвонили» — escalate_to_human, а не новое обещание; аренда собственника и риелтор описаны", () => {
    const text = prompt(true);
    expect(text).toContain("причиной «жалоба: не перезвонили»");
    expect(text).toContain("снова звонок НЕ обещай");
    expect(text).toContain("СДАЁТ квартиру в аренду");
    expect(text).toContain("Риелтор другого агентства");
    expect(text).toContain("Называется нашим сотрудником");
  });
});
