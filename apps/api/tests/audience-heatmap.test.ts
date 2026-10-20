import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DUSHANBE_OFFSET_MS } from "../src/lib/dushanbeTime.js";
import {
  HEATMAP_CHANNELS,
  HEATMAP_CHANNELS_BY_SIGNAL,
  HEATMAP_SIGNALS,
  PUBLISH_LEAD_HOURS,
  loadHeatmapCells,
  recordAudienceMessage,
  summarizeHeatmap,
  type HeatmapCell,
} from "../src/lib/audienceHeatmap.js";

/**
 * Тепловая карта активности (lib/audienceHeatmap.ts). Проверяется то, что
 * ломается молча и чего на карте не видно глазом:
 *  - вывод «во сколько публиковать» — он считается из клеток, а не берётся
 *    из настройки, и ошибка в нём выглядит как правдоподобный совет;
 *  - невозможная пара сигнал+канал («комментарии по телефону») — она обязана
 *    давать пустую карту ДО запроса: `UNION ALL` из нуля кусков это не пустой
 *    результат, а синтаксическая ошибка Postgres;
 *  - наличие «всех каналов» у каждого сигнала — на этом держится сброс канала
 *    при переключении среза на экране (Sources.tsx).
 */

function cell(dow: number, hour: number, count: number): HeatmapCell {
  return { dow, hour, count };
}

describe("Вывод по карте", () => {
  it("пустая карта не выдумывает ни пика, ни совета", () => {
    expect(summarizeHeatmap([])).toEqual({ total: 0, peak: null, liveliestHours: [], publishHours: [] });
  });

  it("клетки с нулями — та же пустая карта, а не пик в нулевой клетке", () => {
    expect(summarizeHeatmap([cell(1, 10, 0), cell(2, 11, 0)]).peak).toBeNull();
  });

  it("пик — самая живая КЛЕТКА, а живые часы считаются по всей неделе сразу", () => {
    const cells = [
      // Вторник 20:00 — самая живая одиночная клетка.
      cell(2, 20, 30),
      // А час 13:00 набирает больше вторничного пика по неделе в целом (4 × 12).
      cell(1, 13, 12),
      cell(2, 13, 12),
      cell(3, 13, 12),
      cell(4, 13, 12),
      cell(5, 9, 5),
    ];
    const summary = summarizeHeatmap(cells);
    expect(summary.total).toBe(83);
    expect(summary.peak).toEqual(cell(2, 20, 30));
    expect(summary.liveliestHours).toEqual([13, 20, 9]);
  });

  it("публиковать советуем на час раньше живого часа, по возрастанию и без повторов", () => {
    const summary = summarizeHeatmap([cell(1, 13, 10), cell(1, 20, 9), cell(1, 9, 8)]);
    expect(summary.liveliestHours).toEqual([13, 20, 9]);
    expect(summary.publishHours).toEqual([8, 12, 19]);
  });

  it("полночь как живой час не уводит совет в минус — переносится на 23:00", () => {
    expect(summarizeHeatmap([cell(6, 0, 7)]).publishHours).toEqual([24 - PUBLISH_LEAD_HOURS]);
  });

  it("при равном числе событий первым идёт ранний час — иначе порядок плавал бы от запроса к запросу", () => {
    expect(summarizeHeatmap([cell(1, 21, 5), cell(1, 8, 5), cell(1, 14, 5)]).liveliestHours).toEqual([8, 14, 21]);
  });
});

describe("Сигналы и каналы", () => {
  it("невозможная пара даёт пустую карту, не дойдя до запроса", async () => {
    // Без базы: `loadHeatmapCells` обязана вернуться раньше, чем пойдёт в неё.
    await expect(loadHeatmapCells({ signal: "comments", channel: "PHONE" })).resolves.toEqual([]);
    await expect(loadHeatmapCells({ signal: "calls", channel: "INSTAGRAM" })).resolves.toEqual([]);
  });

  it("у каждого сигнала есть «все каналы» — на это опирается сброс канала на экране", () => {
    for (const signal of HEATMAP_SIGNALS) {
      expect(HEATMAP_CHANNELS_BY_SIGNAL[signal]).toContain("ALL");
    }
  });

  it("запрос каждого осмысленного среза исполняется в Postgres", async () => {
    // Куски SQL собираются через Prisma.sql и склеиваются UNION ALL — ошибка в
    // склейке видна только на живой базе, ни сборка, ни чистые тесты выше её не
    // поймают. База прогона пустая, поэтому проверяется именно исполнимость.
    for (const signal of HEATMAP_SIGNALS) {
      for (const channel of HEATMAP_CHANNELS_BY_SIGNAL[signal]) {
        await expect(loadHeatmapCells({ signal, channel, days: 7 })).resolves.toBeInstanceOf(Array);
      }
    }
  });

  it("в списках каналов нет выдуманных значений", () => {
    for (const signal of HEATMAP_SIGNALS) {
      for (const channel of HEATMAP_CHANNELS_BY_SIGNAL[signal]) {
        expect(HEATMAP_CHANNELS).toContain(channel);
      }
    }
  });
});

/**
 * СЧЁТ КАЖДОГО СООБЩЕНИЯ (23.09.2026). До счётчика разговор из тридцати
 * реплик весил на карте как разговор из двух (начало и последнее сообщение).
 *
 * База общая с соседними файлами, и те зовут processMessengerTurn — счётчик
 * текущего часа у них тоже растёт. Поэтому свои сообщения кладём в час трое
 * суток назад и сверяем ПРИРОСТ, а не абсолютное число.
 */
describe("Счётчик сообщений переписки", () => {
  const HOUR = 60 * 60 * 1000;
  const at = new Date(Math.floor((Date.now() - 3 * 24 * HOUR) / HOUR) * HOUR + 17 * 60 * 1000);
  const hourStart = new Date(Math.floor(at.getTime() / HOUR) * HOUR);
  const local = new Date(at.getTime() + DUSHANBE_OFFSET_MS);
  const dow = local.getUTCDay();
  const hour = local.getUTCHours();
  const createdConversations: string[] = [];

  afterAll(async () => {
    await prisma.audienceMessageHour.deleteMany({ where: { hourStart, channel: "WEBSITE" } });
    await prisma.botConversation.deleteMany({ where: { id: { in: createdConversations } } });
  });

  const countAt = async (channel: "WEBSITE" | "ALL") => {
    const cells = await loadHeatmapCells({ signal: "chats", channel, days: 7 });
    return cells.find((c) => c.dow === dow && c.hour === hour)?.count ?? 0;
  };

  it("три сообщения в одном часе — три события, а не одно", async () => {
    const before = await countAt("WEBSITE");
    await recordAudienceMessage("WEBSITE", at);
    await recordAudienceMessage("WEBSITE", at);
    await recordAudienceMessage("WEBSITE", at);
    const row = await prisma.audienceMessageHour.findUnique({
      where: { hourStart_channel: { hourStart, channel: "WEBSITE" } },
    });
    expect(row?.count).toBeGreaterThanOrEqual(3);
    expect(await countAt("WEBSITE")).toBe(before + 3);
  });

  it("звонок и выдуманный канал в счётчик не пишутся", async () => {
    await recordAudienceMessage("PHONE", at);
    await recordAudienceMessage("NOPE", at);
    expect(await prisma.audienceMessageHour.count({ where: { hourStart, channel: { in: ["PHONE", "NOPE"] } } })).toBe(0);
  });

  it("после начала счётчика диалог не считается второй раз по своим отметкам", async () => {
    // Счётчик уже идёт (сообщения выше) — новый диалог в том же часе обязан
    // прийти на карту только через счётчик, а не ещё и своими «начался» и
    // «последнее сообщение».
    const before = await countAt("WEBSITE");
    const conversation = await prisma.botConversation.create({
      data: {
        channel: "WEBSITE",
        subscriberId: `heatmap-counter-${Date.now()}`,
        createdAt: at,
        lastMessageAt: new Date(at.getTime() + 2 * HOUR),
      },
    });
    createdConversations.push(conversation.id);
    expect(await countAt("WEBSITE")).toBe(before);
    // И в «все каналы» то же самое.
    const all = await countAt("ALL");
    await recordAudienceMessage("WEBSITE", at);
    expect(await countAt("ALL")).toBe(all + 1);
  });
});
