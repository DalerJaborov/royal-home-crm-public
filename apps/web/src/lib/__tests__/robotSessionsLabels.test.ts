import { describe, expect, it } from "vitest";
import { formatSessionCost, sessionVoiceBy, sessionWho } from "../../components/LiveVoiceSessions";
import { recordingExtension } from "../../components/CallDetails";

describe("подписи сессий робота", () => {
  it("кто на линии — по направлению, а не «тестовый номер» для всех", () => {
    expect(sessionWho({ client: null, direction: "test" })).toBe("Тестовый номер");
    expect(sessionWho({ client: null, direction: "inbound" })).toMatch(/Входящий/);
    expect(sessionWho({ client: null, direction: "outbound" })).toMatch(/Исходящий/);
    expect(sessionWho({ client: null, direction: null })).toBe("Номер без карточки");
    // Ответ сервера без поля direction (до его появления) — прежняя подпись.
    expect(sessionWho({ client: null })).toBe("Тестовый номер");
    expect(sessionWho({ client: { id: "1", fullName: "Фаррух", shortId: 5 }, direction: "inbound" })).toBe("Фаррух");
  });
  it("копеечная стоимость не округляется до нуля", () => {
    expect(formatSessionCost(0.003)).toBe("< $0.01");
    expect(formatSessionCost(0)).toBe("$0.00");
    expect(formatSessionCost(0.04)).toBe("$0.04");
  });
  it("расширение записи по типу", () => {
    expect(recordingExtension("audio/wav")).toBe("wav");
    expect(recordingExtension("audio/x-wav")).toBe("wav");
    expect(recordingExtension("audio/mpeg")).toBe("mp3");
    expect(recordingExtension("")).toBe("mp3");
  });
});

describe("sessionVoiceBy: кто вёл звонок", () => {
  it("словами, без технического жаргона; для старых звонков подписи нет", () => {
    expect(sessionVoiceBy({ provider: "elevenlabs" })).toBe("Голос и слух: ElevenLabs");
    expect(sessionVoiceBy({ provider: "google" })).toBe("Голос и слух: Google");
    expect(sessionVoiceBy({ provider: null })).toBeNull();
    expect(sessionVoiceBy({})).toBeNull();
  });
});
