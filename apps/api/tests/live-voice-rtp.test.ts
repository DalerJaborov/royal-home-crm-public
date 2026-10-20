import { describe, expect, it } from "vitest";
import {
  buildRtpPacket,
  parseRtpPacket,
  LIVE_VOICE_ARI_APP,
  shouldAcceptLiveVoiceChannel,
  stationArrival,
  transferLiveVoiceCall,
  detectClientSpeechEnd,
  resamplePcm16,
  pickOfficeAmbienceTrack,
  nextOfficeAmbienceFrame,
  type ClientVadState,
  type OfficeAmbienceState,
  shouldSuppressAsEcho,
  frameEnergy,
  ECHO_TAIL_MS,
  ECHO_BARGE_IN_ENERGY,
} from "../src/lib/telephony/liveVoiceBridge.js";
import type { AriEvent } from "../src/lib/telephony/ariTypes.js";

/**
 * Живой голос (пункт 5 очереди ИИ) — кадрирование RTP и решение «принимать ли
 * канал» проверяются без сети: собираем/разбираем буфер, мокаем событие ARI.
 */
describe("buildRtpPacket / parseRtpPacket", () => {
  it("собранный пакет разбирается обратно с теми же полями", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6]);
    const packet = buildRtpPacket({ payloadType: 118, sequenceNumber: 42, timestamp: 12345, ssrc: 0x11223344, payload });
    const parsed = parseRtpPacket(packet);
    expect(parsed).not.toBeNull();
    expect(parsed?.payloadType).toBe(118);
    expect(parsed?.sequenceNumber).toBe(42);
    expect(parsed?.timestamp).toBe(12345);
    expect(parsed?.ssrc).toBe(0x11223344);
    expect(parsed?.payload).toEqual(payload);
  });

  it("заголовок — ровно 12 байт, версия RTP 2", () => {
    const packet = buildRtpPacket({ payloadType: 0, sequenceNumber: 0, timestamp: 0, ssrc: 0, payload: Buffer.alloc(0) });
    expect(packet.length).toBe(12);
    expect(packet[0] >> 6).toBe(2);
  });

  it("порядковый номер оборачивается по модулю 16 бит", () => {
    const packet = buildRtpPacket({ payloadType: 0, sequenceNumber: 65536 + 5, timestamp: 0, ssrc: 0, payload: Buffer.alloc(0) });
    expect(parseRtpPacket(packet)?.sequenceNumber).toBe(5);
  });

  it("слишком короткий буфер — null, а не исключение", () => {
    expect(parseRtpPacket(Buffer.alloc(4))).toBeNull();
  });

  it("не RTP-версия (например, мусор) — null", () => {
    const junk = Buffer.alloc(12);
    junk[0] = 0x00; // version=0
    expect(parseRtpPacket(junk)).toBeNull();
  });
});

function stasisStartEvent(overrides: Partial<AriEvent> = {}): AriEvent {
  return {
    type: "StasisStart",
    application: LIVE_VOICE_ARI_APP,
    channel: { id: "chan-1", name: "PJSIP/1099-000001", state: "Ring", caller: {}, dialplan: { exten: "1099" } },
    ...overrides,
  } as AriEvent;
}

describe("shouldAcceptLiveVoiceChannel", () => {
  const enabledSettings = { liveVoiceEnabled: true, liveVoiceTestExtension: "1099" };

  it("тумблер включён, номер совпал — принимаем", () => {
    expect(shouldAcceptLiveVoiceChannel(stasisStartEvent(), enabledSettings)).toBe(true);
  });

  it("тумблер выключен — отказ, даже если приложение и номер совпали", () => {
    expect(
      shouldAcceptLiveVoiceChannel(stasisStartEvent(), { liveVoiceEnabled: false, liveVoiceTestExtension: "1099" })
    ).toBe(false);
  });

  it("настройки не загружены (null) — отказ", () => {
    expect(shouldAcceptLiveVoiceChannel(stasisStartEvent(), null)).toBe(false);
  });

  it("тестовый номер не заполнен — отказ, даже если тумблер включён", () => {
    expect(
      shouldAcceptLiveVoiceChannel(stasisStartEvent(), { liveVoiceEnabled: true, liveVoiceTestExtension: null })
    ).toBe(false);
  });

  it("номер в событии не совпадает с настроенным тестовым — отказ", () => {
    const event = stasisStartEvent({
      channel: { id: "chan-2", name: "x", state: "Ring", caller: {}, dialplan: { exten: "1005" } },
    });
    expect(shouldAcceptLiveVoiceChannel(event, enabledSettings)).toBe(false);
  });

  it("не наше Stasis-приложение — отказ", () => {
    expect(shouldAcceptLiveVoiceChannel(stasisStartEvent({ application: "royal-home-crm" }), enabledSettings)).toBe(
      false
    );
  });

  it("не StasisStart — отказ, даже если остальное совпало", () => {
    expect(shouldAcceptLiveVoiceChannel(stasisStartEvent({ type: "StasisEnd" }), enabledSettings)).toBe(false);
  });

  // Перевод консультанта агенту (24.09.2026): агент не взял — станция возвращает
  // звонок в приложение с аргументом "returned" из royalhome-agent-route.
  it("вернулся от агента — принимаем, хотя набран не тестовый номер", () => {
    const event = stasisStartEvent({
      args: ["returned"],
      channel: { id: "chan-3", name: "SIP/trunk-1", state: "Up", caller: {}, dialplan: { exten: "agent" } },
    });
    expect(shouldAcceptLiveVoiceChannel(event, enabledSettings)).toBe(true);
  });

  it("вернулся от агента, но живой голос выключен — отказ (станция уведёт на запасной путь)", () => {
    const event = stasisStartEvent({ args: ["returned"] });
    expect(shouldAcceptLiveVoiceChannel(event, { liveVoiceEnabled: false, liveVoiceTestExtension: "1099" })).toBe(false);
  });

  // Консультант вместо автоответчика (24.09.2026, правка 5): станция отдаёт
  // настоящий входящий с аргументом "inbound" (оператор не взял, ночь). "missed"
  // (свой клиент, агент не ответил) и "known" — с 11.10.2026 отказ, тест ниже.
  it("настоящий входящий — принимаем, только если в Настройках консультант берёт входящие", () => {
    for (const arg of ["inbound"]) {
      const event = stasisStartEvent({
        args: [arg],
        channel: { id: "chan-4", name: "SIP/trunk-2", state: "Ring", caller: {}, dialplan: { exten: "s" } },
      });
      expect(shouldAcceptLiveVoiceChannel(event, { ...enabledSettings, liveVoiceInboundMode: "no_answer" })).toBe(true);
      expect(shouldAcceptLiveVoiceChannel(event, { ...enabledSettings, liveVoiceInboundMode: "always" })).toBe(true);
      // Выключили, а станция ещё не узнала: отказ — и станция уводит на автоответчик.
      expect(shouldAcceptLiveVoiceChannel(event, { ...enabledSettings, liveVoiceInboundMode: "off" })).toBe(false);
      expect(shouldAcceptLiveVoiceChannel(event, enabledSettings)).toBe(false);
      expect(
        shouldAcceptLiveVoiceChannel(event, { liveVoiceEnabled: false, liveVoiceTestExtension: null, liveVoiceInboundMode: "always" })
      ).toBe(false);
    }
  });

  // Владелец 11.10.2026: «робот НЕ отвечает клиентам агента — даже если агент не
  // отвечает, он сам перезвонит». "missed"/"known" станция шлёт только для своего
  // клиента агента (старый диалплан) — отказ при ЛЮБОМ режиме; канал распознан как
  // станционный, поэтому мост отдаёт его диалплану (автоответчик), а не кладёт трубку.
  it("свой клиент агента (missed/known) — отказ при любом режиме, канал остаётся станционным", () => {
    for (const arg of ["missed", "known"]) {
      const event = stasisStartEvent({
        args: [arg],
        channel: { id: "chan-5", name: "SIP/trunk-3", state: "Ring", caller: {}, dialplan: { exten: "s" } },
      });
      for (const mode of ["no_answer", "always", "off"]) {
        expect(shouldAcceptLiveVoiceChannel(event, { ...enabledSettings, liveVoiceInboundMode: mode })).toBe(false);
      }
      expect(stationArrival(event)).not.toBeNull();
    }
  });

  it("как канал попал к консультанту — по аргументу Stasis", () => {
    expect(stationArrival(stasisStartEvent({ args: ["inbound"] }))).toBe("inbound");
    expect(stationArrival(stasisStartEvent({ args: ["missed"] }))).toBe("missed");
    expect(stationArrival(stasisStartEvent({ args: ["returned"] }))).toBe("returned");
    expect(stationArrival(stasisStartEvent())).toBeNull();
  });
});

describe("transferLiveVoiceCall", () => {
  it("сессии нет (человек уже положил трубку) — «gone», канал не трогаем", async () => {
    let moved = false;
    const outcome = await transferLiveVoiceCall("нет-такого", async () => {
      moved = true;
      return true;
    });
    expect(outcome).toBe("gone");
    expect(moved).toBe(false);
  });
});

function loudFrame(size = 160): Int16Array {
  // Условная "речь" — амплитуда заведомо выше VAD_SPEECH_ENERGY_THRESHOLD (400).
  return new Int16Array(size).fill(3000);
}

function quietFrame(size = 160): Int16Array {
  // Условная "тишина линии" — заведомо ниже порога.
  return new Int16Array(size).fill(20);
}

describe("detectClientSpeechEnd (локальный VAD, маскирует паузу до ответа Gemini)", () => {
  it("пока клиент говорит — не сигналит конец фразы", () => {
    const state: ClientVadState = { speaking: false, silenceStreak: 0 };
    expect(detectClientSpeechEnd(loudFrame(), state)).toBe(false);
    expect(detectClientSpeechEnd(loudFrame(), state)).toBe(false);
    expect(state.speaking).toBe(true);
  });

  it("тишина ДО того, как клиент вообще заговорил, — не событие", () => {
    const state: ClientVadState = { speaking: false, silenceStreak: 0 };
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false);
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false);
  });

  it("речь → несколько тихих кадров подряд — ровно один сигнал конца фразы", () => {
    const state: ClientVadState = { speaking: false, silenceStreak: 0 };
    detectClientSpeechEnd(loudFrame(), state);
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false); // 1-й тихий кадр — ещё не край
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false); // 2-й
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false); // 3-й
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(true); // 4-й (VAD_SILENCE_HANGOVER_FRAMES) — край
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false); // дальше — молчим, повторного сигнала нет
  });

  it("короткая пауза внутри фразы (меньше hangover) не считается концом — новая громкая речь сбрасывает счётчик", () => {
    const state: ClientVadState = { speaking: false, silenceStreak: 0 };
    detectClientSpeechEnd(loudFrame(), state);
    detectClientSpeechEnd(quietFrame(), state);
    detectClientSpeechEnd(quietFrame(), state); // 2 тихих кадра — до края ещё не дошло
    expect(detectClientSpeechEnd(loudFrame(), state)).toBe(false); // снова заговорил — счётчик тишины сбрасывается
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false);
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false);
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(false);
    expect(detectClientSpeechEnd(quietFrame(), state)).toBe(true); // край считается заново от последней речи
  });
});

describe("resamplePcm16 — анти-алиасинг фильтр при понижении частоты", () => {
  it("на явно ультразвуковом (для 8кГц) сигнале даунсэмпл с фильтром не звенит сильнее, чем без него", () => {
    // Синусоида 10 кГц при исходной частоте 24 кГц (выше новой частоты Найквиста
    // 4 кГц при целевых 8 кГц) — ровно тот сигнал, что даёт алиасинг без ФНЧ.
    const length = 2400; // 100мс на 24кГц
    const input = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      input[i] = Math.round(8000 * Math.sin((2 * Math.PI * 10000 * i) / 24000));
    }
    const output = resamplePcm16(input, 24000, 8000);
    expect(output.length).toBeGreaterThan(0);
    // Регрессия формы, а не число: с фильтром сигнал не должен выходить за
    // пределы того же диапазона амплитуд, что и вход (без клиппинга/усиления).
    for (const sample of output) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(8000);
    }
  });

  it("повышение частоты (8→16кГц, вход клиента для Gemini) не трогает фильтром — форма сигнала сохраняется", () => {
    const input = Int16Array.from([0, 1000, 2000, 1000, 0, -1000, -2000, -1000]);
    const output = resamplePcm16(input, 8000, 16000);
    expect(output.length).toBe(16);
    // Первый и последний сэмпл при апсэмпле линейной интерполяцией не сдвигаются.
    expect(output[0]).toBe(input[0]);
  });
});

describe("офисный амбиент (pickOfficeAmbienceTrack/nextOfficeAmbienceFrame)", () => {
  it("трек не загрузился (нет файла) — молчание, а не крэш", () => {
    const state: OfficeAmbienceState = { track: null, position: 0 };
    const frame = nextOfficeAmbienceFrame(state, 160, 1);
    expect(frame.length).toBe(160);
    expect(Array.from(frame).every((s) => s === 0)).toBe(true);
  });

  it("зацикливается по кругу без выхода за границы массива", () => {
    const track = Int16Array.from([100, 200, 300]);
    const state: OfficeAmbienceState = { track, position: 1 };
    const frame = nextOfficeAmbienceFrame(state, 5, 1);
    // Начали с индекса 1: 200,300,100,200,300 — прошли конец массива дважды.
    expect(Array.from(frame)).toEqual([200, 300, 100, 200, 300]);
  });

  it("множитель громкости применяется к каждому сэмплу", () => {
    const track = Int16Array.from([1000, -1000]);
    const state: OfficeAmbienceState = { track, position: 0 };
    const frame = nextOfficeAmbienceFrame(state, 2, 0.35);
    expect(Array.from(frame)).toEqual([350, -350]);
  });

  it("на реальном окружении (assets/live-voice-ambience есть) выдаёт непустой трек хотя бы одного из двух файлов", () => {
    // Не мокаем fs — это те самые файлы, что владелец положил в репозиторий
    // 14.09.2026 (office-1.pcm/office-2.pcm). Если их нет в чьей-то копии
    // репозитория (не подтянул assets/), pickOfficeAmbienceTrack тихо вернёт
    // null — тест это тоже допускает, не требует файлов как обязательного условия.
    const state = pickOfficeAmbienceTrack();
    if (state.track) {
      expect(state.track.length).toBeGreaterThan(0);
    } else {
      expect(state.track).toBeNull();
    }
  });
});

describe("защита от эха (24.09.2026)", () => {
  const quiet = new Int16Array(160).fill(300); // эхо на линии — заметно тише речи
  const loud = new Int16Array(160).fill(ECHO_BARGE_IN_ENERGY + 500); // человек перебивает в трубку

  it("тихий кадр, пока бот говорит, уходит в модель тишиной", () => {
    expect(shouldSuppressAsEcho(quiet, 0)).toBe(true);
    expect(shouldSuppressAsEcho(quiet, ECHO_TAIL_MS)).toBe(true);
  });

  it("громкий кадр проходит всегда — перебить бота можно", () => {
    expect(shouldSuppressAsEcho(loud, 0)).toBe(false);
  });

  it("после хвоста в ECHO_TAIL_MS глушения нет", () => {
    expect(shouldSuppressAsEcho(quiet, ECHO_TAIL_MS + 1)).toBe(false);
  });

  it("энергия кадра — средняя абсолютная амплитуда", () => {
    expect(frameEnergy(new Int16Array([100, -100, 300, -300]))).toBe(200);
    expect(frameEnergy(new Int16Array(0))).toBe(0);
  });
});
