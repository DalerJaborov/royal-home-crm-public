import { describe, expect, it } from "vitest";
import {
  dailyPublishCapacity,
  nextPublishSlot,
  priorityWindowsFromHours,
  DEFAULT_PUBLISH_SCHEDULE_RULES,
  PUBLISH_WINDOW_START_MIN,
  PUBLISH_WINDOW_END_MIN,
  MIN_GAP_MIN,
  type PublishScheduleRules,
} from "../src/lib/publishSchedule.js";
import { dushanbeDateTimeString, dushanbeInputToDate } from "../src/lib/dushanbeTime.js";

/**
 * Расстановка публикаций по времени (lib/publishSchedule.ts) — чистая
 * арифметика, без БД и без времени выполнения теста. Проверяется то, ради
 * чего задача вообще возникла: пачка из десяти роликов не уходит одним
 * залпом, — и границы, которые молча дали бы неправдоподобный час (полночь,
 * следующий год).
 */
function d(date: string, time: string): Date {
  return dushanbeInputToDate(date, time);
}
function hm(at: Date): string {
  return dushanbeDateTimeString(at).slice(-5);
}

describe("Слоты публикации", () => {
  it("пустая очередь среди дня метит в ближайшее приоритетное окно", () => {
    const slot = nextPublishSlot(d("2026-09-22", "10:00"), null);
    expect(hm(slot.at)).toBe("12:00");
  });

  it("между приоритетными окнами метит во второе, а не в первое (оно уже прошло)", () => {
    const slot = nextPublishSlot(d("2026-09-22", "15:00"), null);
    expect(hm(slot.at)).toBe("19:00");
  });

  it("внутри приоритетного окна — не назад, а с текущего момента", () => {
    const slot = nextPublishSlot(d("2026-09-22", "13:00"), null);
    expect(hm(slot.at)).toBe("13:00");
  });

  it("после последнего приоритетного окна и до конца дня — сразу же, без ожидания завтра", () => {
    const slot = nextPublishSlot(d("2026-09-22", "20:00"), null);
    expect(hm(slot.at)).toBe("20:00");
  });

  it("следующая публикация в занятой очереди отступает ровно на минимальный промежуток", () => {
    const last = d("2026-09-22", "12:00");
    const slot = nextPublishSlot(d("2026-09-22", "12:05"), last);
    expect(hm(slot.at)).toBe("13:30");
    expect(slot.at.getTime() - last.getTime()).toBe(MIN_GAP_MIN * 60_000);
  });

  it("занятая очередь тоже метит в живой час — не в пустое 15:00 между окнами (24.09.2026)", () => {
    // До 24.09.2026 ответ был 15:00 (13:30 + 90 минут): в приоритет метила
    // только первая публикация пачки. Владелец: «чтобы мы всегда попадали к
    // своей аудитории» — теперь следующая ждёт ближайшего окна, 19:00.
    const last = d("2026-09-22", "13:30");
    const slot = nextPublishSlot(d("2026-09-22", "13:35"), last);
    expect(hm(slot.at)).toBe("19:00");
  });

  it("пачка роликов подряд не уходит одним залпом — любые два минимум в полутора часах друг от друга", () => {
    // С 24.09.2026 лучшие часы занимаются первыми, и слот следующего ролика может
    // оказаться РАНЬШЕ предыдущего — поэтому расстановке передаются все уже
    // занятые слоты, а промежуток проверяется между соседями по времени.
    const now = d("2026-09-22", "10:00");
    const slots: Date[] = [];
    for (let i = 0; i < 5; i++) slots.push(nextPublishSlot(now, slots).at);
    const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].getTime() - sorted[i - 1].getTime()).toBeGreaterThanOrEqual(MIN_GAP_MIN * 60_000);
    }
  });

  it("после конца рабочего окна — на завтрашний приоритетный час, а не в оставшуюся ночь", () => {
    // До 23.09.2026 здесь ожидалось завтрашнее открытие окна (09:00). Это было
    // расхождение с соседним случаем «ролик принят ночью» (03:00 → 12:00):
    // положение одинаковое — очередь пуста, впереди целый рабочий день, — а
    // ответ разный, причём 09:00 по тепловой карте один из самых пустых часов.
    // Ночь по-прежнему исключена, ради чего тест и заводился.
    const slot = nextPublishSlot(d("2026-09-22", "22:30"), null);
    expect(hm(slot.at)).toBe("12:00");
    expect(slot.at.getTime()).toBeGreaterThan(d("2026-09-23", "00:00").getTime());
  });

  it("занятая очередь, отступ которой ушёл за конец окна, переносится на завтрашний живой час, а не на 09:00", () => {
    const last = d("2026-09-22", "20:00");
    const slot = nextPublishSlot(d("2026-09-22", "20:05"), last);
    expect(hm(slot.at)).toBe("12:00");
    expect(slot.at.getTime()).toBeGreaterThan(d("2026-09-23", "00:00").getTime());
  });

  it("ролик принят ночью — пустая очередь всё равно метит в ближайшее приоритетное окно того же дня", () => {
    const slot = nextPublishSlot(d("2026-09-22", "03:00"), null);
    expect(hm(slot.at)).toBe("12:00");
  });

  it("очередь занята и отступ уводит за конец дня — завтрашний живой час, а не ночь", () => {
    const slot = nextPublishSlot(d("2026-09-22", "20:30"), d("2026-09-22", "20:30"));
    expect(hm(slot.at)).toBe("12:00");
    expect(slot.at.getTime()).toBeGreaterThan(d("2026-09-22", "23:59").getTime());
  });

  it("ролик принят ночью, а очередь заняли только что — тоже живой час, а не открытие окна", () => {
    // До 24.09.2026 занятая очередь здесь брала 09:00; теперь, как и пустая, — 12:00.
    const slot = nextPublishSlot(d("2026-09-22", "03:00"), d("2026-09-22", "02:00"));
    expect(hm(slot.at)).toBe("12:00");
  });

  it("константы совпадают с тем, что показывает тепловая карта на /sources", () => {
    expect(PUBLISH_WINDOW_START_MIN).toBe(9 * 60);
    expect(PUBLISH_WINDOW_END_MIN).toBe(21 * 60);
  });
});

/**
 * ДАВНЯЯ ПУБЛИКАЦИЯ ОЧЕРЕДЬ НЕ ДЕРЖИТ (22.09.2026). `lastScheduled` берётся
 * запросом «последняя расставленная публикация вообще», и ею легко оказывается
 * вчерашняя. Отступ в полтора часа от неё давал слот В ПРОШЛОМ — то есть
 * публикацию «прямо сейчас», мимо приоритетных часов, ровно то, ради чего
 * расстановка и заводилась.
 */
describe("Давняя публикация не считается очередью", () => {
  it("прошлая публикация была вчера — слот не в прошлом, а в ближайшем приоритетном часе", () => {
    const slot = nextPublishSlot(d("2026-09-22", "15:00"), d("2026-09-21", "10:00"));
    expect(hm(slot.at)).toBe("19:00");
  });

  it("прошлая публикация была три часа назад — тот же ближайший приоритетный час", () => {
    const slot = nextPublishSlot(d("2026-09-22", "11:00"), d("2026-09-22", "08:00"));
    expect(hm(slot.at)).toBe("12:00");
  });

  it("прошлая публикация была полчаса назад — очередь держит, отступаем на промежуток от неё", () => {
    const slot = nextPublishSlot(d("2026-09-22", "11:00"), d("2026-09-22", "10:30"));
    expect(hm(slot.at)).toBe("12:00");
  });

  it("слот никогда не оказывается в прошлом, какой бы давней ни была прошлая публикация", () => {
    const now = d("2026-09-22", "15:00");
    for (const last of [d("2026-09-20", "09:00"), d("2026-09-21", "20:00"), d("2026-09-22", "09:00")]) {
      expect(nextPublishSlot(now, last).at.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });
});

/**
 * СЕТКА ИЗ НАСТРОЕК И ЧАСЫ ИЗ ТЕПЛОВОЙ КАРТЫ (23.09.2026, владелец: «чтобы
 * ролики уже по расписанию выходили по карте… все это должно быть в
 * настройках»). До этого дня числа 09:00-21:00, 90 минут и 12-14/19-21 были
 * вшиты в код, и «настроить» их означало выпустить новую версию.
 *
 * Здесь проверяется, что правила действительно РАБОТАЮТ, а не только
 * принимаются: подменённое окно двигает слот, выключенное расписание отдаёт
 * момент приёма, а часы, собранные из карты, попадают в расстановку ровно как
 * приоритетные окна.
 */
describe("Расстановка по правилам из настроек", () => {
  const rules = (over: Partial<PublishScheduleRules> = {}): PublishScheduleRules => ({
    ...DEFAULT_PUBLISH_SCHEDULE_RULES,
    ...over,
  });

  it("выключенное расписание отдаёт момент приёма, а не слот", () => {
    const now = d("2026-09-22", "03:17");
    const slot = nextPublishSlot(now, null, rules({ enabled: false }));
    expect(slot.at.getTime()).toBe(now.getTime());
    expect(slot.reason).toMatch(/выключено/i);
  });

  it("выключенное расписание не держит очередь — десять роликов уйдут залпом, и это осознанный выбор владельца", () => {
    const now = d("2026-09-22", "12:00");
    const slot = nextPublishSlot(now, d("2026-09-22", "11:59"), rules({ enabled: false }));
    expect(slot.at.getTime()).toBe(now.getTime());
  });

  it("своё рабочее окно двигает слот: открытие в 11:00 — ролик из ночи ждёт до 11:00", () => {
    const slot = nextPublishSlot(
      d("2026-09-22", "04:00"),
      null,
      rules({ windowStartMin: 11 * 60, priorityWindows: [] })
    );
    expect(hm(slot.at)).toBe("11:00");
  });

  it("свой конец окна переносит на завтра раньше: закрытие в 18:00 — ролик в 18:30 уже завтрашний", () => {
    const slot = nextPublishSlot(
      d("2026-09-22", "18:30"),
      null,
      rules({ windowEndMin: 18 * 60, priorityWindows: [] })
    );
    expect(hm(slot.at)).toBe("09:00");
    expect(slot.at.getTime()).toBeGreaterThan(d("2026-09-23", "00:00").getTime());
  });

  it("свой промежуток между публикациями соблюдается вместо вшитых 90 минут", () => {
    const last = d("2026-09-22", "12:00");
    const slot = nextPublishSlot(d("2026-09-22", "12:01"), last, rules({ minGapMin: 40 }));
    expect(slot.at.getTime() - last.getTime()).toBe(40 * 60_000);
  });

  it("часы из тепловой карты становятся приоритетными окнами", () => {
    const slot = nextPublishSlot(
      d("2026-09-22", "10:00"),
      null,
      rules({ priorityWindows: priorityWindowsFromHours([16, 20]), prioritySource: "heatmap" })
    );
    expect(hm(slot.at)).toBe("16:00");
    expect(slot.reason).toMatch(/карт/i);
  });

  it("причина слота честно называет источник часа — карта или настройки", () => {
    const byMap = nextPublishSlot(
      d("2026-09-22", "10:00"),
      null,
      rules({ priorityWindows: priorityWindowsFromHours([16]), prioritySource: "heatmap" })
    );
    const byFixed = nextPublishSlot(d("2026-09-22", "10:00"), null, rules({ prioritySource: "fixed" }));
    expect(byMap.reason).toMatch(/карт/i);
    expect(byFixed.reason).toMatch(/настро/i);
    expect(byMap.reason).not.toBe(byFixed.reason);
  });

  it("пустой список приоритетных часов не ломает расстановку — публикуем в окне без ожидания", () => {
    const slot = nextPublishSlot(d("2026-09-22", "10:00"), null, rules({ priorityWindows: [] }));
    expect(hm(slot.at)).toBe("10:00");
  });

  it("у любого слота есть непустая причина — иначе в карточке объекта будет пустое место", () => {
    const cases: [Date, Date | null][] = [
      [d("2026-09-22", "03:00"), null],
      [d("2026-09-22", "10:00"), null],
      [d("2026-09-22", "20:00"), null],
      [d("2026-09-22", "22:30"), null],
      [d("2026-09-22", "12:05"), d("2026-09-22", "12:00")],
      [d("2026-09-22", "20:05"), d("2026-09-22", "20:00")],
    ];
    for (const [now, last] of cases) {
      const slot = nextPublishSlot(now, last);
      expect(slot.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("Часы тепловой карты в приоритетные окна", () => {
  it("час 19 — это отрезок 19:00-20:00", () => {
    expect(priorityWindowsFromHours([19])).toEqual([[19 * 60, 20 * 60]]);
  });

  it("часы сортируются и не дублируются — порядок важен, по нему ищется ближайший", () => {
    expect(priorityWindowsFromHours([20, 12, 20])).toEqual([
      [12 * 60, 13 * 60],
      [20 * 60, 21 * 60],
    ]);
  });

  it("мусор из карты отбрасывается, а не превращается в слот в позапрошлом веке", () => {
    expect(priorityWindowsFromHours([-1, 24, 99, 1.5, Number.NaN, 13])).toEqual([[13 * 60, 14 * 60]]);
  });
});

/**
 * КАЖДЫЙ РОЛИК — В ЖИВОЙ ЧАС, И У КАЖДОГО ДНЯ СВОЙ ПИК (24.09.2026, владелец
 * прислал снимок статистики Instagram: воскресенье 18–23, вторник 18–21 —
 * «чтобы мы всегда попадали к своей аудитории»).
 */
describe("Живые часы для каждого ролика и каждого дня", () => {
  const rules = (over: Partial<PublishScheduleRules> = {}): PublishScheduleRules => ({
    ...DEFAULT_PUBLISH_SCHEDULE_RULES,
    ...over,
  });
  const inWindows = (at: Date, windows: readonly (readonly [number, number])[]) => {
    const [h, m] = hm(at).split(":").map(Number);
    const min = h * 60 + m;
    return windows.some(([a, b]) => min >= a && min < b);
  };

  it("пачка роликов: сначала все живые часы дня, потом свободные часы того же дня — на завтра без нужды не уходит", () => {
    const now = d("2026-09-22", "09:00");
    const slots: Date[] = [];
    for (let i = 0; i < 8; i++) slots.push(nextPublishSlot(now, slots).at);
    // Окна 12–14 и 19–21 при промежутке 90 минут вмещают четыре ролика —
    // первые четыре встают туда.
    for (const at of slots.slice(0, 4)) expect(inWindows(at, DEFAULT_PUBLISH_SCHEDULE_RULES.priorityWindows)).toBe(true);
    // Окно 09:00–21:00 вмещает восемь — все восемь выходят сегодня.
    expect(slots.every((at) => at.getTime() < d("2026-09-23", "00:00").getTime())).toBe(true);
    const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].getTime() - sorted[i - 1].getTime()).toBeGreaterThanOrEqual(MIN_GAP_MIN * 60_000);
    }
  });

  it("день заполнен целиком — следующий ролик на завтра, в живой час", () => {
    const now = d("2026-09-22", "09:00");
    const slots: Date[] = [];
    for (let i = 0; i < 9; i++) slots.push(nextPublishSlot(now, slots).at);
    const ninth = slots[8];
    expect(ninth.getTime()).toBeGreaterThan(d("2026-09-23", "00:00").getTime());
    expect(inWindows(ninth, DEFAULT_PUBLISH_SCHEDULE_RULES.priorityWindows)).toBe(true);
  });

  it("свободный час выбирается по весу часа, а не просто самый ранний", () => {
    const weights = new Array(24).fill(1);
    weights[16] = 50; // 16:00 вне приоритетных окон, но живее утра
    const r = rules({ priorityWindows: [], hourWeights: weights, prioritySource: "heatmap" });
    expect(hm(nextPublishSlot(d("2026-09-22", "09:30"), null, r).at)).toBe("16:00");
  });

  it("в день влезает столько роликов, сколько позволяют окно и промежуток", () => {
    expect(dailyPublishCapacity({ windowStartMin: 9 * 60, windowEndMin: 21 * 60, minGapMin: 90 })).toBe(8);
    expect(dailyPublishCapacity({ windowStartMin: 9 * 60, windowEndMin: 21 * 60, minGapMin: 60 })).toBe(12);
  });

  it("у дня недели свой пик: вторник по своим часам, среда — по своим", () => {
    // 22.09.2026 — вторник, 23.09 — среда.
    const byDow: [number, number][][] = [];
    byDow[2] = priorityWindowsFromHours([17]);
    byDow[3] = priorityWindowsFromHours([11]);
    const r = rules({ priorityWindows: priorityWindowsFromHours([14]), priorityWindowsByDow: byDow, prioritySource: "instagram" });
    expect(hm(nextPublishSlot(d("2026-09-22", "10:00"), null, r).at)).toBe("17:00");
    // Во вторник после закрытия окна — среда, по часам среды.
    const wed = nextPublishSlot(d("2026-09-22", "21:30"), null, r);
    expect(hm(wed.at)).toBe("11:00");
    expect(wed.at.getTime()).toBeGreaterThan(d("2026-09-23", "00:00").getTime());
    expect(wed.reason).toMatch(/Instagram/);
    // Четверга в списке нет — общие часы.
    expect(hm(nextPublishSlot(d("2026-09-24", "10:00"), null, r).at)).toBe("14:00");
  });

  it("пик после конца рабочего окна слотом не становится — ночью не публикуем", () => {
    const r = rules({ priorityWindows: priorityWindowsFromHours([22]), prioritySource: "instagram" });
    const slot = nextPublishSlot(d("2026-09-22", "10:00"), null, r);
    // Окно 09:00–21:00, пик 22:00 в него не входит — окон нет вовсе, публикуем в окне.
    expect(hm(slot.at)).toBe("10:00");
  });
});
