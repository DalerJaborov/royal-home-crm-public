import { prisma } from "../db.js";

/**
 * ДЕТЕКТОР «ВАЖНОЕ В ПРОЧИХ ОБРАЩЕНИЯХ» (mission-control, фаза 2, п.1d жалобы
 * `docs/razbor-zhaloby-admina-31-08-2026.md`): всё, что не покупатель и не
 * продавец (`ClientKind.OTHER`), уходит одной кучей в «Прочие обращения»
 * (видно только руководству, `routes/clients/list.ts`) — владелец хочет
 * выделить из этой кучи то, что реально требует его внимания.
 *
 * ПОДХОД (ii) ИЗ ПЛАНА, А НЕ ПОЛНЫЙ ИИ-ПРОГОН НА КАЖДОЕ ОБРАЩЕНИЕ. Дешёвая
 * keyword-эвристика при чтении дашборда — без нового персистентного поля и без
 * оплаты токенов на каждое «прочее» обращение (их поток небольшой, но
 * непредсказуемый, а раунд-трип к модели на каждое — реальная задержка/цена,
 * которую владелец явно не заказывал). Тот же класс решения, что и у
 * `staleContactRequests.ts` рядом: ключевые слова вместо NLP, потому что
 * остальные детекторы первой линии устроены так же (`callbackRequests.ts`,
 * `lib/clientTransfer.ts CONFLICT_KEYWORDS`).
 *
 * ИСТОЧНИК ТЕКСТА. Прямого текстового поля «сообщение клиента» на карточке нет —
 * смотрим то же, что видит агент/руководитель: последние реплики привязанного
 * диалога (BotConversation/TelegramConversation) и заметки недавних Interaction
 * (расшифровка звонка/итог). Окно то же, что у соседнего детектора, — 48ч.
 */
const URGENT_RE =
  /(жалоб|в\s*суд|судом|адвокат|прокурат|полици|обман(ул|ывает|ули)?|мошен|угроз|компенсаци|верните\s*деньги|штраф|незакон|расторж|расторгн|претензи|скандал|шантаж)/iu;

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 48;
const RESULT_CAP = 30;
const SNIPPET_PAD = 40;

function extractRecentText(messages: unknown, maxMessages = 6): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .slice(-maxMessages)
    .map((m) =>
      m && typeof m === "object" && typeof (m as { content?: unknown }).content === "string"
        ? (m as { content: string }).content
        : ""
    )
    .join(" \n ");
}

export interface ImportantOtherInquiryItem {
  id: string;
  shortId: number;
  fullName: string;
  snippet: string;
  seenAt: Date;
}

/**
 * OTHER-клиенты за последние 48ч (по созданию карточки или свежему сообщению в
 * привязанном диалоге), чей текст содержит признак «важно» — жалоба, угроза
 * судом/полицией, требование денег и т.п.
 */
export async function findImportantOtherInquiries(now: Date = new Date()): Promise<{
  items: ImportantOtherInquiryItem[];
}> {
  const windowStart = new Date(now.getTime() - WINDOW_HOURS * HOUR_MS);

  const clients = await prisma.client.findMany({
    where: {
      kind: "OTHER",
      deletedAt: null,
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      OR: [
        { createdAt: { gte: windowStart } },
        { botConversation: { some: { lastMessageAt: { gte: windowStart } } } },
        { telegramConversation: { lastMessageAt: { gte: windowStart } } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      createdAt: true,
      botConversation: {
        select: { messages: true, lastMessageAt: true },
        orderBy: { lastMessageAt: "desc" },
        take: 1,
      },
      telegramConversation: { select: { messages: true, lastMessageAt: true } },
      interactions: {
        where: { createdAt: { gte: windowStart }, type: { in: ["CALL", "MESSAGE", "SYSTEM"] } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { notes: true, createdAt: true },
      },
    },
  });
  if (clients.length === 0) return { items: [] };

  const items: ImportantOtherInquiryItem[] = [];
  for (const c of clients) {
    const texts: string[] = [];
    let seenAt = c.createdAt;
    for (const bc of c.botConversation) {
      texts.push(extractRecentText(bc.messages));
      if (bc.lastMessageAt && bc.lastMessageAt > seenAt) seenAt = bc.lastMessageAt;
    }
    if (c.telegramConversation) {
      texts.push(extractRecentText(c.telegramConversation.messages));
      if (c.telegramConversation.lastMessageAt && c.telegramConversation.lastMessageAt > seenAt) {
        seenAt = c.telegramConversation.lastMessageAt;
      }
    }
    for (const it of c.interactions) {
      texts.push(it.notes ?? "");
      if (it.createdAt > seenAt) seenAt = it.createdAt;
    }
    const combined = texts.join(" \n ");
    const match = URGENT_RE.exec(combined);
    if (!match) continue;
    const from = Math.max(0, match.index - SNIPPET_PAD);
    const snippet = combined.slice(from, match.index + match[0].length + SNIPPET_PAD).trim().replace(/\s+/g, " ");
    items.push({ id: c.id, shortId: c.shortId, fullName: c.fullName, snippet, seenAt });
  }

  items.sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime());
  return { items: items.slice(0, RESULT_CAP) };
}
