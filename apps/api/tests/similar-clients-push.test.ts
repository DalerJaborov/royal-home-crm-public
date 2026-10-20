import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * ПУШ РУКОВОДИТЕЛЮ ПРИ ОЧЕНЬ ВЫСОКОМ СОВПАДЕНИИ ЗАМЕТОК (владелец 19.08.2026,
 * пункт 3 защиты от дублей). Баннер на карточке пассивный — руководитель может
 * его не заметить; при похожести выше 0.75 при СОЗДАНИИ новой карточки прямо
 * пушится тем, у кого есть право clients.merge.
 */

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents, sendPushToAgent: vi.fn(async () => 1),
}));

const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
const t = String(runId).slice(-6);
// Хвост для «непохожего» покупателя ниже — намеренно ДРУГОЙ набор цифр, не
// просто t. Общий t в номере (+992976t/+992977t/+992978t) — те же последние
// 6 цифр у всех трёх карточек этого файла — сам по себе задевает новый
// нечёткий детектор дублей (lib/duplicateReview.ts, план §L, «похожее имя и
// похожий номер по последним цифрам»), который тут не при чём: тест проверяет
// пуш по совпадению ЗАМЕТОК, а не по близости номера/имени.
const t2 = String((Number(t) + 500000) % 1_000_000).padStart(6, "0");
const clientIds: string[] = [];
let adminId = "";

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Таймаут ожидания");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  adminId = (
    await prisma.agent.create({
      data: { fullName: `Директор похожести ${runId}`, phone: `+992975${t}`, role: "ADMIN", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("Пуш при очень высоком совпадении заметок", () => {
  it("пушит руководителю, когда новая карточка почти дословно совпадает со старой", async () => {
    // Текст намеренно уникален для этого прогона (хвост runId) — иначе он может
    // случайно совпасть с фикстурой другого тестового файла в общей базе.
    const notes =
      `Дом с отдельным двором на Зарафшон-${t}, требуется установить забор и новые ворота, деревянный дом одноэтажный со скважиной`;
    const first = await createLeadFromChannel({
      fullName: `Продавец А ${runId}`,
      phone: `+992976${t}`,
      source: "INSTAGRAM",
      kind: "SELLER",
      requirementsNotes: notes,
    });
    clientIds.push(first.clientId);

    sendPushToAgents.mockClear();
    const second = await createLeadFromChannel({
      fullName: `Продавец Б ${runId}`,
      phone: `+992977${t}`,
      source: "WHATSAPP",
      kind: "SELLER",
      requirementsNotes: notes,
    });
    clientIds.push(second.clientId);

    await waitFor(() => sendPushToAgents.mock.calls.length > 0);
    const call = sendPushToAgents.mock.calls[0];
    expect(call[0]).toEqual(expect.arrayContaining([adminId]));
    expect(call[1].body).toContain("Продавец А");
  });

  it("не пушит, если заметки не похожи", async () => {
    sendPushToAgents.mockClear();
    const lead = await createLeadFromChannel({
      fullName: `Покупатель непохожий ${t2}`,
      phone: `+992978${t2}`,
      source: "INSTAGRAM",
      // Тип указан явно (30.08.2026): без него лид теперь заводится как «прочее
      // обращение» — бот не понял человека, и в раздачу агентам такой не идёт.
      // Руководству при этом уходит СВОЙ push «Новое обращение», и проверка
      // «пуша не было вовсе» ловила бы его, а не тот, ради которого написана.
      kind: "BUYER",
      requirementsNotes: `Ищу гараж под мастерскую рядом с рынком Корвон-${t2}, недорого, можно без ремонта`,
    });
    clientIds.push(lead.clientId);

    await new Promise((r) => setTimeout(r, 200));
    /**
     * Ни один push не должен быть про совпадение ЗАМЕТОК с «Продавцом А/Б» из
     * первого теста — это единственное, что этот тест проверяет. Раньше
     * проверялось по общему слову «похож» в любом пуше системы — хрупко само
     * по себе (04.09.2026, найдено при интеграции задачи L): в общей dev-базе
     * теперь ЕЩЁ и синхронная проверка «похожее имя + похожий номер»
     * (lib/duplicateReview.ts::findFuzzyDuplicateCandidate, вызывается на
     * КАЖДЫЙ новый лид из services/leads/intake.ts) — у неё своя, не связанная
     * с заметками причина для пуша со словом «похож», и она может сработать на
     * случайное совпадение хвоста номера с любой другой карточкой в базе,
     * накопленной за долгую сессию. Проверяем по имени конкретных клиентов
     * первого теста, а не по слову — так тест остаётся про то, для чего написан.
     */
    const notesSimilarityPushes = sendPushToAgents.mock.calls.filter(([, payload]) => {
      const text = `${(payload as Record<string, string>).title ?? ""} ${(payload as Record<string, string>).body ?? ""}`;
      return text.includes(`Продавец А ${runId}`) || text.includes(`Продавец Б ${runId}`);
    });
    expect(notesSimilarityPushes).toHaveLength(0);
  });
});
