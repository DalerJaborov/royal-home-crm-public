import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { pickFreeExtension } from "../src/lib/telephony/extensionPool.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Автовыдача внутренних номеров (07.08.2026).
 *
 * Правило, ради которого написан файл: номер новому сотруднику берётся из пула,
 * заведённого на АТС, и никогда не выдаётся дважды. Ошибка здесь тихая и неприятная —
 * два человека с одним номером означают, что звонки одного приходят другому, и
 * заметят это далеко не сразу.
 */

/**
 * Основание участка пула подбирается ПО БАЗЕ, а не наугад: четырёхзначное
 * случайное число вполне может быть уже закреплено за живым сотрудником, и
 * тогда «первый свободный» окажется вторым — тест упадёт на исправном коде
 * (замер 11.09.2026: ждали 1002, получили 1003). См. helpers/extensionBase.ts.
 */
const runId = await reserveExtensionBase(6);
const createdAgentIds: string[] = [];
const fetchMock = vi.fn();

function endpointsResponse(resources: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => resources.map((r) => ({ technology: "SIP", resource: r, state: "unknown" })),
  } as Response;
}

beforeAll(async () => {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      asteriskAriUrl: "http://ari.pool-test:8088",
      asteriskAriUsername: "royalhome-crm",
      asteriskAriPassword: encryptSecret("secret"),
    },
    update: {
      asteriskAriUrl: "http://ari.pool-test:8088",
      asteriskAriUsername: "royalhome-crm",
      asteriskAriPassword: encryptSecret("secret"),
    },
  });
});

afterEach(async () => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  if (createdAgentIds.length) {
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds.splice(0) } } });
  }
});

afterAll(async () => {
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } })
    .catch(() => {});
  await prisma.$disconnect();
});

async function createAgentWithExtension(extension: string) {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Занявший ${extension}`,
      phone: `+99290${runId}${extension.slice(-2)}`,
      role: "AGENT",
      passwordHash: "x",
      sipExtension: extension,
    },
  });
  createdAgentIds.push(agent.id);
  return agent;
}

describe("Пул внутренних номеров", () => {
  it("выдаёт первый свободный номер по порядку", async () => {
    fetchMock.mockResolvedValue(endpointsResponse([`${runId + 1}`, `${runId + 2}`, `${runId + 3}`]));
    vi.stubGlobal("fetch", fetchMock);

    const picked = await pickFreeExtension();

    expect(picked.extension).toBe(`${runId + 1}`);
    expect(picked.reason).toBeUndefined();
  });

  it("не выдаёт номер, который уже закреплён за сотрудником", async () => {
    await createAgentWithExtension(`${runId + 1}`);
    fetchMock.mockResolvedValue(endpointsResponse([`${runId + 1}`, `${runId + 2}`]));
    vi.stubGlobal("fetch", fetchMock);

    const picked = await pickFreeExtension();

    expect(picked.extension).toBe(`${runId + 2}`);
  });

  it("транк не попадает в пул: это не внутренний номер и звонить с него нельзя", async () => {
    // В /ari/endpoints вперемешку лежат и внутренние номера, и транки провайдера.
    fetchMock.mockResolvedValue(endpointsResponse(["out", "trunk-megafon", `${runId + 5}`]));
    vi.stubGlobal("fetch", fetchMock);

    const picked = await pickFreeExtension();

    expect(picked.extension).toBe(`${runId + 5}`);
  });

  it("когда свободных нет — честная причина, а не молчаливый null", async () => {
    await createAgentWithExtension(`${runId + 1}`);
    fetchMock.mockResolvedValue(endpointsResponse([`${runId + 1}`]));
    vi.stubGlobal("fetch", fetchMock);

    const picked = await pickFreeExtension();

    expect(picked.extension).toBeNull();
    expect(picked.reason).toBe("свободных номеров нет");
  });

  it("АТС недоступна — заведение сотрудника не срывается, номер просто не выдан", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const picked = await pickFreeExtension();

    expect(picked.extension).toBeNull();
    expect(picked.reason).toBe("АТС недоступна");
  });

  /**
   * 22.09.2026: до этого «АТС недоступна» терялась насовсем — возвращалась только
   * этой строкой в интерфейсе Настроек, а в журнале ошибок не оставляла следа.
   * Поведение (откат на "АТС недоступна", заведение сотрудника не срывается) не
   * меняется — проверяем, что теперь ЕЩЁ И появляется читаемая запись в журнале.
   */
  it("отказ АТС попадает в журнал ошибок понятной причиной", async () => {
    // Маркер уникален на каждый прогон: десятиминутная дедупликация
    // logSystemError (см. lib/systemError.ts) иначе схлопывает повторный
    // локальный прогон этого теста с записью от прошлого прогона — тест
    // должен стеречь «пишет в журнал», а не гоняться с собственным дедупом
    // (поймано 22.09.2026).
    const marker = randomUUID();
    // С 02.10.2026 (E11) запись идёт с постоянным ключом вида поломки, и
    // десятиминутный дедуп склеивает её с записью прошлого прогона независимо
    // от маркера в тексте — убираем прошлую запись этого вида.
    await prisma.errorLog.deleteMany({ where: { source: "telephony", dedupKey: { startsWith: "Пул внутренних номеров" } } });
    // Очистка выше не спасает от СОСЕДА: тесты идут в четыре процесса на одной
    // базе, и любой из них, заводя сотрудника при недоступной АТС, пишет запись
    // этого же вида между нашей очисткой и нашим вызовом — десятиминутный дедуп
    // склеивал с ней нашу, и запись с маркером не появлялась (поймано на
    // сведении #1030, 02.10.2026). Соседа здесь кладём сами, а «сейчас» для
    // кода сдвигаем на сутки вперёд: окно дедупа считается от Date.now(),
    // createdAt ставит база, так что любая чужая запись оказывается старше окна.
    await prisma.errorLog.create({
      data: { source: "telephony", message: "Пул внутренних номеров — АТС недоступна: сосед", dedupKey: "Пул внутренних номеров — АТС недоступна: …" },
    });
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 24 * 60 * 60 * 1000);
    fetchMock.mockRejectedValue(new Error(`ECONNREFUSED 85.198.70.182:8088 (${marker})`));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const picked = await pickFreeExtension();
      expect(picked.reason).toBe("АТС недоступна");

      // Тот же марker попадает и в промежуточную запись «первая попытка
      // сорвалась» (listEndpointsRetrying, п.5) — оба фоновых `void`-вызова
      // пишутся асинхронно, и порядок появления строк в базе не гарантирован.
      // Ищем именно итоговую запись пула, а не любую с этим маркером.
      const row = await waitFor(
        () =>
          prisma.errorLog.findFirst({
            where: {
              source: "telephony",
              AND: [{ message: { contains: marker } }, { message: { contains: "Пул внутренних номеров" } }],
            },
            orderBy: { createdAt: "desc" },
          }),
        { label: "запись об отказе пула номеров в журнале" }
      );
      expect(row?.message).toContain("Пул внутренних номеров");
      expect(row?.message).toContain("АТС недоступна");
      expect(row?.message).toContain("ECONNREFUSED");
    } finally {
      // Восстанавливаем только после ожидания: фоновая запись должна считать
      // окно дедупа от сдвинутого «сейчас», а она идёт в отрыве от вызова.
      nowSpy.mockRestore();
    }
  });
});
