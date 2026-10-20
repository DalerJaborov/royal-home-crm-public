import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ALL_SCREENS } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { loadMorningNumbers } from "../src/lib/morningNumbers.js";
import { recordHit, flushRouteHits } from "../src/lib/routeHits.js";

/**
 * КАРТА ОБСЛЕДОВАННОГО — экраны, куда не заходил никто.
 *
 * Проверяется не «функция возвращает массив», а три решения, от которых зависит,
 * поверит ли владелец списку:
 *   1) молчит, пока наблюдение моложе недели — иначе в первые дни «не заходили»
 *      будет написано почти про всё, и настоящая находка утонет;
 *   2) посещённый экран из списка исчезает;
 *   3) счётчик копит в памяти и пишет пачкой — значит без сброса в базе пусто.
 *
 * Обратный контроль обязателен: без него тест «список непустой» одинаково зелен
 * и когда логика работает, и когда она всегда возвращает всё подряд.
 */
/**
 * ПОЧЕМУ ЗДЕСЬ ЧИСТКА ВСЕЙ ТАБЛИЦЫ, А НЕ ПО МАРКЕРУ (сверка 11.09.2026).
 *
 * Общее правило набора — никогда не стирать чужое: выборка сужается своим
 * runId, а уборка трогает только свои строки. Здесь это невозможно и вот
 * почему: проверяемая функция (loadMorningNumbers → unvisitedScreens) отвечает
 * «каких экранов НЕТ в таблице», то есть смотрит на таблицу целиком. Одна
 * чужая строка меняет ответ, и сузить выборку нечем — маркера у отсутствия
 * записи не бывает.
 *
 * Цена признана допустимой: RouteHit — счётчик посещений, чистая телеметрия.
 * Ни одна другая проверка набора на него не опирается, а сама статистика
 * восстанавливается первым же заходом в CRM.
 */
describe("карта обследованного: непосещённые экраны", () => {
  beforeEach(async () => {
    await prisma.routeHit.deleteMany({});
  });

  afterAll(async () => {
    await prisma.routeHit.deleteMany({});
  });

  it("наблюдения нет вовсе — список пуст, а не «не заходили никуда»", async () => {
    const numbers = await loadMorningNumbers();
    expect(numbers.unvisitedScreens).toEqual([]);
  });

  it("наблюдение моложе недели — молчит, даже если экраны не посещались", async () => {
    await prisma.routeHit.create({
      data: {
        kind: "screen",
        key: "/clients",
        count: 1,
        // Вчера: неделя ещё не набралась.
        firstSeenAt: new Date(Date.now() - 1 * 86_400_000),
        lastSeenAt: new Date(),
      },
    });

    const numbers = await loadMorningNumbers();
    expect(numbers.unvisitedScreens).toEqual([]);
  });

  it("наблюдение старше недели — показывает всё, кроме посещённого", async () => {
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await prisma.routeHit.create({
      data: { kind: "screen", key: "/clients", count: 5, firstSeenAt: longAgo, lastSeenAt: new Date() },
    });

    const numbers = await loadMorningNumbers();

    // Посещённый исчез из списка…
    expect(numbers.unvisitedScreens).not.toContain("/clients");
    // …а непосещённые в нём есть — иначе проверка выше зеленела бы на пустом списке.
    expect(numbers.unvisitedScreens.length).toBe(ALL_SCREENS.length - 1);
    expect(numbers.unvisitedScreens).toContain("/deals");
  });

  it("маршруты сервера не путаются с экранами", async () => {
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await prisma.routeHit.create({
      // Тот же ключ, но другой вид записи: как маршрут API он не должен
      // засчитываться за посещение ОДНОИМЁННОГО экрана.
      data: { kind: "api", key: "/clients", count: 5, firstSeenAt: longAgo, lastSeenAt: new Date() },
    });

    const numbers = await loadMorningNumbers();
    expect(numbers.unvisitedScreens).toContain("/clients");
  });

  it("счётчик копит в памяти и пишет только по сбросу", async () => {
    recordHit("screen", "/finance");
    // До сброса в базе ничего нет — в этом и смысл буфера: наблюдение не должно
    // стоить запроса к базе на каждый переход между экранами.
    expect(await prisma.routeHit.count()).toBe(0);

    await flushRouteHits();

    const row = await prisma.routeHit.findUnique({
      where: { kind_key: { kind: "screen", key: "/finance" } },
    });
    expect(row?.count).toBe(1);
  });
});
