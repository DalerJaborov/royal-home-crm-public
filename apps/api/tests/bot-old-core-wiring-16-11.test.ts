import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * РЕВЬЮ #207 (С1, С5, С6): сторожа старого ядра проверяются не по одному, а там, где они стоят.
 *  - сигнал агенту «бот пообещал звонок» — одна дверь, после доставки, не на свежую заявку;
 *  - ответ, который устарел, пока бот думал;
 *  - подключение сторожей к ходу чата и к ответу под комментарием.
 */
const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { requestAgentAttention, FRESH_LEAD_QUIET_MS } = await import("../src/lib/agentAttention.js");
const { newerClientMessagePending } = await import("../src/messengers/turnSupersede.js");
const { applyObjectFactGuards } = await import("../src/ai/objectFactsChat.js");

const runId = Date.now().toString(36);
const agentIds: string[] = [];
const clientIds: string[] = [];

async function agentAndClient(suffix: string, createdAt: Date) {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент сигнала ${runId}-${suffix}`, phone: `+99293${suffix}${runId}`.slice(0, 13), role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(agent.id);
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент сигнала ${runId}-${suffix}`,
      phone: `+99294${suffix}${runId}`.slice(0, 13),
      source: "PHONE_CALL",
      acceptedAt: createdAt,
      createdAt,
      assignedAgentId: agent.id,
    },
  });
  clientIds.push(client.id);
  return { agent, client };
}

beforeEach(() => sendPushToAgent.mockClear());
afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("сигнал агенту: одна дверь, без шума (С1)", () => {
  it("обещан звонок старому клиенту — одна метка и один пуш; второй раз — молчим", async () => {
    const { agent, client } = await agentAndClient("1", new Date(Date.now() - 3 * FRESH_LEAD_QUIET_MS));
    expect(await requestAgentAttention(client.id, "call_promised")).toBe("sent");
    expect(await requestAgentAttention(client.id, "call_promised")).toBe("duplicate");
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    expect(sendPushToAgent).toHaveBeenCalledWith(agent.id, expect.objectContaining({ tag: `agent-attention-${client.id}` }));
    const saved = await prisma.client.findUnique({ where: { id: client.id }, select: { agentAttentionRequestedAt: true } });
    expect(saved?.agentAttentionRequestedAt).toBeInstanceOf(Date);
  });

  it("свежая заявка (агенту только что ушёл пуш о новой заявке) — второго CRITICAL нет", async () => {
    const { client } = await agentAndClient("2", new Date());
    expect(await requestAgentAttention(client.id, "call_promised")).toBe("fresh_lead");
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("метку «агенту надо связаться» ставит только lib/agentAttention.ts (сторож одной двери)", () => {
    const root = path.resolve(import.meta.dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "generated") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (/agentAttentionRequestedAt:\s*new Date\(/.test(text) && !full.endsWith(path.join("lib", "agentAttention.ts"))) offenders.push(full);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("сигнал отправляет транспорт ПОСЛЕ доставки ответа, а не ход до проверки паузы", () => {
    const webhooks = readFileSync(path.resolve(import.meta.dirname, "../src/routes/webhooks.ts"), "utf8");
    const sent = webhooks.indexOf("replySent = true;\n      // Обещание звонка доехало");
    expect(sent).toBeGreaterThan(0);
    expect(webhooks.slice(sent, sent + 400)).toMatch(/providerAcceptedReply && result\.agentSignal\) void requestAgentAttention/);
    const conversation = readFileSync(path.resolve(import.meta.dirname, "../src/messengers/conversation.ts"), "utf8");
    expect(conversation).not.toMatch(/requestAgentAttention\([^)]*"call_promised"/);
  });
});

describe("ответ устарел, пока бот думал (С5)", () => {
  const row = (pending: unknown[]) => ({ pendingSince: new Date(), pendingMessages: pending });

  it("в буфере новое сообщение по делу — этот ответ не уходит", () => {
    expect(newerClientMessagePending(row(["60 квадрата"]), false)).toBe(true);
  });

  it("«ок», «👍», «Рахмат» в буфере — ответ уходит (их ход может промолчать)", () => {
    expect(newerClientMessagePending(row(["ок"]), false)).toBe(false);
    expect(newerClientMessagePending(row(["👍"]), false)).toBe(false);
    expect(newerClientMessagePending(row(["Рахмат"]), false)).toBe(false);
  });

  it("буфер пуст или это повтор сохранённого хода — ответ уходит", () => {
    expect(newerClientMessagePending({ pendingSince: null, pendingMessages: [] }, false)).toBe(false);
    expect(newerClientMessagePending(row(["60 квадрата"]), true)).toBe(false);
  });

  it("ход чата спрашивает буфер перед отправкой", () => {
    const conversation = readFileSync(path.resolve(import.meta.dirname, "../src/messengers/conversation.ts"), "utf8");
    expect(conversation).toMatch(/newerClientMessagePending\(lateRow, !!input\.skipSaveIncoming\)/);
  });
});

describe("подключение сторожей к ходу (С6)", () => {
  const props =
    "\n\nЧТО У НАС СЕЙЧАС ЕСТЬ ПОДХОДЯЩЕГО:\n- №192 Дом 5-комн., Сино, Навбахор 2, ориентир: Кольцевая, Военный городок, 1 380 000 с., 183 м², состояние: требует ремонта";
  const history = [
    { role: "user" as const, content: "Ассаламу алейкум адрес кучоба" },
    { role: "assistant" as const, content: "Ин ҳавлӣ 5-ҳуҷрагӣ, 183 м², 1 380 000 сомонӣ. Суроға: ноҳияи Сино" },
    { role: "user" as const, content: "Адрес кучодай" },
  ];

  it("выдуманное место вырезано, весь ответ был выдумкой — честное «скажет агент»", () => {
    const out = applyObjectFactGuards({
      reply: ["Ин ҳавлӣ дар Зарафшон, наздики бозорча ҷойгир аст"],
      propsBlock: props,
      geoBlock: "",
      folkGeography: "Зарафшон, Лучоби поён",
      history,
      language: "tg",
    });
    expect(out.streets).toEqual(["Зарафшон"]);
    expect(out.reply).toEqual(["Ҷои аниқ ва ҳолати хонаро агенти мо мегӯяд."]);
  });

  it("справочник народных названий место объекта не узаконивает, перевод ориентира — да", () => {
    const out = applyObjectFactGuards({
      reply: ["Ин хона наздики Шаҳраки ҳарбӣ ҷойгир аст. Нархаш 1 380 000 сомонӣ."],
      propsBlock: props,
      geoBlock: "",
      folkGeography: "Зарафшон",
      history,
      language: "tg",
    });
    expect(out.streets).toEqual([]);
    expect(out.reply).toHaveLength(1);
  });

  it("«с ремонтом» про объект «требует ремонта» — вырезано тем же подключением", () => {
    const out = applyObjectFactGuards({
      reply: ["Ин ҳавлӣ 183 м² бо ремонти нав аст. Агар хоҳед, нишон медиҳем."],
      propsBlock: props,
      geoBlock: "",
      folkGeography: "",
      history,
      language: "tg",
    });
    expect(out.renovationRemoved).toBe(1);
    expect(out.reply.join(" ")).not.toMatch(/ремонт/);
  });

  it("ход квалификатора зовёт именно это подключение", () => {
    const lq = readFileSync(path.resolve(import.meta.dirname, "../src/ai/leadQualifier.ts"), "utf8");
    expect(lq).toMatch(/const facts = applyObjectFactGuards\(\{/);
    expect(lq).toMatch(/result\.reply = facts\.reply;/);
  });

  it("ответ под комментарием: сверка цены стоит во всех трёх местах выхода", () => {
    const comments = readFileSync(path.resolve(import.meta.dirname, "../src/messengers/comments.ts"), "utf8");
    expect(comments.match(/await priceSafe\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
