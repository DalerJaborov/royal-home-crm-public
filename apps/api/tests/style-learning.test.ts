import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * САМООБУЧЕНИЕ СТИЛЮ И ОСВЕДОМЛЁННОСТЬ О ЖИВОМ СОТРУДНИКЕ (владелец 22.08.2026).
 *
 * База здесь НЕ нужна и подключаться не должна: всё ценное в этой задаче — чистые
 * преобразования текста (что попадает в пример, что вычищается, что видит модель).
 * Prisma подменён, чтобы тест ловил именно логику, а не состояние стенда.
 *
 * Что проверяется и почему именно это:
 *  1. Телефон НЕ попадает в сохранённый пример. Пример уходит в системный промт
 *     КАЖДОГО разговора с ЛЮБЫМ другим клиентом — утёкший номер бот однажды
 *     продиктует постороннему человеку. Это самый дорогой из возможных промахов
 *     этой правки, поэтому проверок на него больше всего.
 *  2. Ранжирование идёт по близости к текущему вопросу, а не по свежести —
 *     иначе на «сколько стоит» в промт попадают образцы про что угодно.
 *  3. Реплики живого сотрудника модель видит помеченными и не считает своими.
 *  4. Смайлики разрешены обратно (решение 22.08.2026), а грубые — нет.
 */

/** Ровно те поля, что пишет rememberAgentReply, — чтобы подмена была типизированной
 *  и тест ловил переименование колонки, а не падал в рантайме. */
interface StyleRow {
  clientText: string;
  agentText: string;
  agentId: string | null;
  source: string;
  channel: string | null;
}
const create = vi.fn(async (_args: { data: StyleRow }) => ({ id: "x" }));
const findMany = vi.fn(async (_args?: unknown): Promise<StyleRow[]> => []);
// $disconnect — не формальность: общий tests/setup.ts закрывает соединения после
// каждого файла и зовёт его на ЛЮБОМ prisma, включая подменённый.
vi.mock("../src/db.js", () => ({
  prisma: { styleExample: { create, findMany }, $disconnect: () => Promise.resolve() },
}));

const { sanitizeStyleText, rememberAgentReply, renderStyleBlock, scoreStyleExample } = await import(
  "../src/ai/styleLearning.js"
);
const { markHumanRepliesForModel, hasHumanReplies, HUMAN_REPLY_AWARENESS_RULE, BOT_CORE_RULES } = await import(
  "../src/ai/leadQualifier.js"
);

beforeEach(() => {
  create.mockClear();
  findMany.mockClear();
});

describe("чистка примера перед сохранением", () => {
  it("телефон в любой записи не доживает до примера", () => {
    for (const phone of ["+992 93 700 11 22", "910001044", "+7 999 123 45 67", "93-700-11-22"]) {
      const cleaned = sanitizeStyleText(`Занг занед ${phone}, агент ҷавоб медиҳад`);
      expect(cleaned).not.toMatch(/\d{6,}/);
      expect(cleaned).toContain("Занг занед");
    }
  });

  it("номер рядом с валютой тоже вычищается — здесь это не цена, а риск", () => {
    // maskPhones нарочно щадит числа рядом с валютой (иначе замажет цену клиенту).
    // Для вечно живущего образца размен обратный: цена в нём не нужна, номер недопустим.
    expect(sanitizeStyleText("рақамам 910001044 сомонӣ")).not.toContain("910001044");
  });

  it("ник клиента не остаётся в примере", () => {
    expect(sanitizeStyleText("@shoga7820, салом")).toBe("@…, салом");
  });

  it("обычный текст остаётся живым — иначе учить будет нечему", () => {
    const text = "Ин 2-хонага дар Сино, ремонташ нав. Дидан мехоҳед?";
    expect(sanitizeStyleText(text)).toBe(text);
  });
});

describe("сохранение примера", () => {
  it("пара «вопрос → ответ сотрудника» сохраняется без телефона и с автором", async () => {
    const saved = await rememberAgentReply({
      clientText: "Салом, рақами шумо чанд?",
      agentText: "Салом! Рақами ман 910001044, занг занед",
      agentId: "agent-1",
      source: "TAKEOVER",
      channel: "INSTAGRAM",
    });

    expect(saved).toBe(true);
    const data = create.mock.calls[0][0].data;
    expect(data.agentText).not.toContain("910001044");
    expect(data.agentText).toContain("Салом!");
    // agentId нужен, чтобы потом отсеять примеры того, кто отвечает плохо.
    expect(data.agentId).toBe("agent-1");
    expect(data.source).toBe("TAKEOVER");
    expect(data.channel).toBe("INSTAGRAM");
  });

  it("служебная пометка CRM и пустой ответ примером не становятся", async () => {
    expect(await rememberAgentReply({ clientText: "салом", agentText: "[📷 фото]", source: "TAKEOVER" })).toBe(false);
    expect(await rememberAgentReply({ clientText: "салом", agentText: " ", source: "TAKEOVER" })).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * ОТБОР УЖЕСТОЧЁН 23.08.2026 ПО ЖИВЫМ ДАННЫМ.
   *
   * Первый импорт с прода дал 132 образца, и среди них оказался мусор: «Hi» в
   * ответ на «Can you provide complete information?», «hello darlin», и больше
   * половины пар — вовсе без вопроса клиента. Образец читается в промте КАЖДОГО
   * следующего разговора, поэтому это не безобидный шум: бот учится отвечать
   * односложно на содержательный вопрос. Тесты ниже стерегут каждый вид мусора
   * отдельно — по одному живому примеру на правило.
   */
  it("односложный ответ образцом не становится — «Hi» на живой вопрос", async () => {
    expect(
      await rememberAgentReply({
        clientText: "Can you provide complete information?",
        agentText: "Hi",
        source: "HISTORY",
      })
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("ответ из одного приветствия — не манера: как здороваться, бот знает из правил", async () => {
    for (const greeting of ["Салом", "Ассалому алейкум", "hello darlin", "Здравствуйте!"]) {
      expect(
        await rememberAgentReply({ clientText: "Хона мекобам дар Сино", agentText: greeting, source: "HISTORY" })
      ).toBe(false);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("без вопроса клиента пара не сохраняется — её нечем отранжировать", async () => {
    expect(
      await rememberAgentReply({
        clientText: "",
        agentText: "Рақами телефон ва номатонро нависед, то агенти мо занг занад",
        source: "HISTORY",
      })
    ).toBe(false);
    // Вложение вопросом тоже не является: видно, что прислали, но не видно, о чём спросили.
    expect(
      await rememberAgentReply({
        clientText: "[📷 фото]",
        agentText: "Рақами телефон ва номатонро нависед, то агенти мо занг занад",
        source: "HISTORY",
      })
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("вежливость клиента вопросом не считается — «Рахмат» не спрашивал ни о чём", async () => {
    // Живой случай из импорта: «Рахмат» → «Салом Алейкум! Номи ман Шахноза…».
    // Реплики шли подряд, но ответом друг другу не были — как образец это ложь.
    for (const pleasantry of ["Рахмат", "ок", "Майлаш", "спасибо"]) {
      expect(
        await rememberAgentReply({
          clientText: pleasantry,
          agentText: "Салом Алейкум! Номи ман Шахноза, ман менеджери Royal Home",
          source: "HISTORY",
        })
      ).toBe(false);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("клиент назвал только имя — это не вопрос, учиться приветствию в ответ нечему", async () => {
    // Живые пары из импорта 23.08: человек назвал имя (бот просит его вместе с
    // номером), агент поздоровался. Владелец распорядился такие убрать.
    for (const name of ["Файзибек", "Хабиб !", "Нурмуҳаммад"]) {
      expect(
        await rememberAgentReply({
          clientText: name,
          agentText: "Салом Алейкум! Номи ман Шахноза, ман менеджери Royal Home",
          source: "HISTORY",
        })
      ).toBe(false);
    }
    // Но два слова или вопросительный знак — уже разговор по делу.
    expect(
      await rememberAgentReply({
        clientText: "Шумо бинен",
        agentText: "Шумо рақами телефонатонро гузоред, ба шумо мутахассиси ширкат тамос мегирад",
        source: "HISTORY",
      })
    ).toBe(true);
  });

  it("настоящая пара «вопрос по делу → ответ по делу» проходит фильтр", async () => {
    expect(
      await rememberAgentReply({
        clientText: "Дар Сино 2-хонага ҳаст?",
        agentText: "Ҳа, чанд варианти хуб дорем. Рақаматонро нависед, агент занг мезанад",
        source: "HISTORY",
      })
    ).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("дубль в базе — не ошибка: обучение не имеет права ронять переписку", async () => {
    create.mockRejectedValueOnce(new Error("Unique constraint failed"));
    await expect(
      rememberAgentReply({ clientText: "нархаш чанд?", agentText: "41 ҳазор доллар", source: "HISTORY" })
    ).resolves.toBe(false);
  });
});

describe("отбор образцов в промт", () => {
  const pool = [
    { clientText: "Салом, кор доред?", agentText: "Салом! Ҳозир ҷои холӣ нест", source: "HISTORY" },
    { clientText: "Ин хона нархаш чанд?", agentText: "41 ҳазор доллар, ремонташ нав", source: "HISTORY" },
    { clientText: "Кадом тараф ҷойгир аст?", agentText: "Дар Сино, назди парки Айнӣ", source: "HISTORY" },
  ];

  it("вперёд идёт случай на ТОТ ЖЕ вопрос, а не самый свежий", () => {
    const block = renderStyleBlock(pool, "нархаш чанд?");
    const price = block.indexOf("41 ҳазор доллар");
    const jobs = block.indexOf("Ҳозир ҷои холӣ нест");
    expect(price).toBeGreaterThanOrEqual(0);
    expect(price).toBeLessThan(jobs);
  });

  it("живая поправка сотрудника весомее старой переписки при равном вопросе", () => {
    const ask = ["нархаш", "чанд"];
    const takeover = scoreStyleExample({ clientText: "нархаш чанд", agentText: "a", source: "TAKEOVER" }, ask);
    const history = scoreStyleExample({ clientText: "нархаш чанд", agentText: "a", source: "HISTORY" }, ask);
    expect(takeover).toBeGreaterThan(history);
  });

  it("блок честно объявляет себя образцом тона, а правила оставляет главнее", () => {
    const block = renderStyleBlock(pool, "нархаш чанд?");
    expect(block).toContain("ПЕРЕНИМАЙ МАНЕРУ");
    expect(block).toContain("Правила выше главнее");
  });

  it("примеров нет — промт побайтово прежний", () => {
    expect(renderStyleBlock([], "нархаш чанд?")).toBe("");
  });
});

describe("бот знает, что отвечал живой сотрудник", () => {
  const history = [
    { role: "user" as const, content: "Салом, ин хона ҳаст?" },
    { role: "assistant" as const, content: "Салом! Ҳа, ҳаст", by: { kind: "bot" as const } },
    { role: "user" as const, content: "Кай дидан мумкин?" },
    {
      role: "assistant" as const,
      content: "Пагоҳ соати 17 мешавад",
      by: { kind: "agent" as const, agentId: "a1", agentName: "Умед" },
    },
  ];

  it("реплика агента уходит в модель с пометкой автора, реплика бота — без", () => {
    const marked = markHumanRepliesForModel(history);
    expect(marked[3].content).toContain("живой сотрудник Умед");
    expect(marked[3].content).toContain("Пагоҳ соати 17 мешавад");
    // Свои же слова бот пометкой не получает — иначе промт растёт на каждом ходе.
    expect(marked[1].content).toBe("Салом! Ҳа, ҳаст");
    expect(marked[0].content).toBe("Салом, ин хона ҳаст?");
  });

  it("ответ руками из мессенджера (автор неизвестен) тоже помечается", () => {
    const marked = markHumanRepliesForModel([
      { role: "assistant", content: "Ҳозир мефиристам", by: { kind: "manual" } },
    ]);
    expect(marked[0].content).toContain("живой сотрудник");
  });

  it("исходный массив не портится — он же уходит в запись истории", () => {
    markHumanRepliesForModel(history);
    expect(history[3].content).toBe("Пагоҳ соати 17 мешавад");
  });

  it("правило печатается только там, где человек реально вмешивался", () => {
    expect(hasHumanReplies(history)).toBe(true);
    expect(hasHumanReplies(history.slice(0, 2))).toBe(false);
  });

  it("правило запрещает переспрашивать и приходить «с середины»", () => {
    expect(HUMAN_REPLY_AWARENESS_RULE).toContain("НЕ переспрашивай");
    expect(HUMAN_REPLY_AWARENESS_RULE).toContain("с середины");
  });
});

/**
 * СМАЙЛИКИ — ПРАВИЛО, КОТОРОЕ ХОДИЛО ПО КРУГУ ТРИЖДЫ, И ЭТО САМОЕ ВАЖНОЕ В НЁМ.
 *
 * 01.08.2026 запрет ввели; 22.08.2026 днём сняли («современные безобидные
 * смайлики всегда можно использовать»); 22.08.2026 вечером вернули — и по ДРУГОЙ
 * причине, чем в первый раз: «убери смайлики, они выдают бота». Дело не в
 * приличиях, а в ровности: живой человек ставит смайлик неровно, бот — всегда
 * одинаково, и эта ровность выдаёт его вернее любой формулировки.
 *
 * Тесты ниже написаны днём под снятый запрет и вечером устарели — поправлены
 * 23.08.2026 вместе со сменой решения. Проверяется не «нет смайликов», а то,
 * что в правиле цела ИСТОРИЯ и цело ИСКЛЮЧЕНИЕ: без первого следующий читатель
 * решит, что правило потеряли, и снимет его в четвёртый раз; без второго
 * потеряется единственное место, где владелец смайлик оставил.
 *
 * Запрет грубых смайликов здесь НЕ проверяется намеренно: когда смайликов нет
 * вовсе, перечислять грубые в промте незачем — их режет код (RUDE_EMOJI в
 * ai/replyGuards.ts, messengers/comments.ts, lib/leadMagnet.ts), и это покрыто
 * в tests/reply-guards.test.ts. Промт просит, код гарантирует.
 */
describe("смайлики (решение владельца 22.08.2026, вечер)", () => {
  it("запрет вернулся, и история решения в правиле цела", () => {
    expect(BOT_CORE_RULES).toContain("СМАЙЛИКОВ НЕТ");
    // Причина возврата — не «неприлично», а «выдаёт бота». Потеряв её, легко
    // снять запрет снова, посчитав его вкусовщиной.
    expect(BOT_CORE_RULES).toContain("выдают бота");
    expect(BOT_CORE_RULES).toContain("01.08.2026");
    expect(BOT_CORE_RULES).toContain("22.08.2026");
  });

  it("исключение для комментариев под постом сохранено", () => {
    // Владелец 22.08 днём: «в комментариях можно ставить смайлик, когда
    // благодарим». Вечерний запрет это исключение НЕ отменил — смайлик остаётся
    // там, где он и есть весь ответ (см. isReactionOnly в messengers/comments.ts).
    expect(BOT_CORE_RULES).toContain("комментариях");
  });
});
