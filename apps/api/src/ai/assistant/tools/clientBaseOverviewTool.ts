import { z } from "zod";
import type { PermissionId } from "@royal-home/shared";
import { loadClientBaseOverview, type ClientBaseOverview, type ReasonCount } from "../../../lib/clientBaseOverview.js";
import type { AssistantActor } from "../actor.js";
import { dealLang, type DealLang } from "./dealToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * get_client_base_overview — «СКОЛЬКО КЛИЕНТОВ, СКОЛЬКО АКТИВНЫХ, ПОЧЕМУ НЕАКТИВНЫ»
 * ОДНИМ ОТВЕТОМ (17.11.2026, директор просил дважды).
 *
 * Тонкая обёртка над lib/clientBaseOverview.ts — той же базой, что у сводки экрана
 * «Клиенты» (GET /clients/summary): второй реализации правил нет. Главное, чтобы
 * модель НЕ выдумывала «неактивных»: таких статусов с 16.11.2026 нет, поэтому
 * ответ сам называет, что значит каждое число (поле `meaning`), и даёт готовый
 * текст `display`.
 *
 * Права — как у экрана: без clients.viewAll — только свои покупатели и продавцы
 * (и своя Корзина), с ним — вся компания и разбивка по агентам. Только личка:
 * в общей группе Telegram скрыт (GROUP_HIDDEN_TOOLS) и отказывает здесь.
 * Имена клиентов и телефоны не отдаются вовсе — только числа и имена сотрудников.
 */

const LANG_PROP = {
  type: "string",
  enum: ["ru", "tg"],
  description: "Язык, на котором пишет сотрудник: ru — русский, tg — таджикский",
} as const;

const argsSchema = z.object({ lang: z.enum(["ru", "tg"]).optional() });

const has = (actor: AssistantActor, permission: PermissionId) => actor.permissions?.has(permission) ?? false;
const inGroup = (actor: AssistantActor) => actor.surface === "telegram-group";
const tr = (lang: DealLang, ru: string, tg: string) => (lang === "tg" ? tg : ru);

/** Сколько причин показывать строкой; остальные — «и ещё N». */
const REASON_LINES = 5;

function reasonsText(lang: DealLang, reasons: ReasonCount[]): string[] {
  const shown = reasons.slice(0, REASON_LINES).map((r) => `   • ${r.label} — ${r.count}`);
  const rest = reasons.slice(REASON_LINES).reduce((sum, r) => sum + r.count, 0);
  if (rest > 0) shown.push(tr(lang, `   • прочие причины — ${rest}`, `   • сабабҳои дигар — ${rest}`));
  return shown;
}

export function renderClientBaseOverview(o: ClientBaseOverview, lang: DealLang): string {
  const scope = o.scope === "own" ? tr(lang, "ваши клиенты", "мизоҷони шумо") : tr(lang, "вся компания", "тамоми ширкат");
  const lines: (string | null)[] = [
    tr(lang, `👥 Клиентская база — ${scope}, на ${o.asOf}`, `👥 Базаи мизоҷон — ${scope}, то ${o.asOf}`),
    tr(lang, `Всего (без Корзины): ${o.total}`, `Ҳамагӣ (бе Сабад): ${o.total}`),
    "",
    tr(lang, `✅ В работе: ${o.inWork.total}`, `✅ Дар кор: ${o.inWork.total}`),
    tr(lang, `   покупатели ${o.inWork.buyers} · продавцы ${o.inWork.sellers}`, `   харидорон ${o.inWork.buyers} · фурӯшандагон ${o.inWork.sellers}`) +
      (o.inWork.other !== null ? tr(lang, ` · прочие обращения ${o.inWork.other}`, ` · муроҷиатҳои дигар ${o.inWork.other}`) : ""),
    tr(lang, `   из них без контакта больше суток: ${o.inWork.noContact}`, `   аз онҳо зиёда аз як шабонарӯз бе тамос: ${o.inWork.noContact}`),
    tr(lang, `   ждут принятия агентом: ${o.inWork.awaitingAcceptance}`, `   интизори қабули агент: ${o.inWork.awaitingAcceptance}`),
    o.inWork.withoutAgent !== null && o.inWork.withoutAgent > 0
      ? tr(lang, `   без агента: ${o.inWork.withoutAgent}`, `   бе агент: ${o.inWork.withoutAgent}`)
      : null,
    "",
    tr(lang, `⏸ Не в работе: ${o.notInWork.total}`, `⏸ Дар кор нестанд: ${o.notInWork.total}`),
    tr(lang, `   сделка закрыта: ${o.notInWork.dealClosed}`, `   муомила баста шуд: ${o.notInWork.dealClosed}`),
    tr(lang, `   работа завершена, ждёт решения руководителя: ${o.notInWork.workCompleted}`, `   кор анҷом ёфт, қарори роҳбарро интизор: ${o.notInWork.workCompleted}`),
    tr(lang, `   в Архиве: ${o.notInWork.archived}`, `   дар Бойгонӣ: ${o.notInWork.archived}`),
    o.pendingDelete.count > 0
      ? o.pendingDelete.includedInTotal
        ? tr(lang, `📝 Из всех — с заявкой на удаление, ждут решения: ${o.pendingDelete.count}`, `📝 Аз ҳама — бо дархости нест кардан, қарорро интизор: ${o.pendingDelete.count}`)
        : tr(lang, `📝 Ещё ${o.pendingDelete.count} — с заявкой на удаление, ждут решения руководителя`, `📝 Боз ${o.pendingDelete.count} — бо дархости нест кардан, қарори роҳбарро интизор`)
      : null,
    "",
    tr(lang, `❌ Отказы «Без сделки» за ${o.windowLabel}: ${o.refusals.total}`, `❌ Радҳо «Бе муомила» дар ${o.windowLabel}: ${o.refusals.total}`),
    ...reasonsText(lang, o.refusals.reasons),
    tr(lang, `🗑 Корзина: всего ${o.trash.total}, за ${o.windowLabel} — ${o.trash.lastWindow}`, `🗑 Сабад: ҳамагӣ ${o.trash.total}, дар ${o.windowLabel} — ${o.trash.lastWindow}`),
    ...reasonsText(lang, o.trash.reasons),
    o.trash.withoutRequest > 0
      ? tr(lang, `   • удалил руководитель без заявки — ${o.trash.withoutRequest}`, `   • роҳбар бе дархост нест кард — ${o.trash.withoutRequest}`)
      : null,
  ];
  if (o.byAgent && o.byAgent.rows.length > 0) {
    lines.push("", tr(lang, "👤 По агентам (в работе · без контакта):", "👤 Аз рӯи агентҳо (дар кор · бе тамос):"));
    for (const row of o.byAgent.rows) lines.push(`   ${plainField(row.name, 80) ?? "—"} — ${row.inWork} · ${row.noContact}`);
    if (o.byAgent.more > 0) lines.push(tr(lang, `   …и ещё ${o.byAgent.more}`, `   …ва боз ${o.byAgent.more}`));
  }
  return lines.filter((l): l is string => l !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Что значит каждое число — для модели, чтобы не придумывала «неактивных». */
const MEANING = {
  inWork: "В работе = в списке «Клиенты» у агента: не в Корзине, без закрытой сделки, не в Архиве, работа не завершена.",
  noContact: "Без контакта = в работе, но больше суток не было ни разговора по телефону, ни сообщения от самого клиента (то же, что плитка «Без контакта»).",
  notInWork: "Не в работе = сделка закрыта, Архив, или агент завершил работу (отказ на пределе передач) и решение за руководителем.",
  noStatuses: "Статусов «Активный/Неактивный/Отложенный/Потерянный» в CRM нет с 16.11.2026. На вопрос «сколько неактивных» отвечай: не в работе + без контакта, с причинами из ответа.",
  refusals: "Отказы = нажатия «Без сделки» за окно, причина выбирается агентом.",
  trash: "Корзина = удалённые карточки; причины за окно — по одобренным заявкам на удаление.",
} as const;

export const getClientBaseOverviewTool: AssistantReadToolPlugin = {
  name: "get_client_base_overview",
  level: "A",
  statusPhrase: "Считаю клиентскую базу…",
  description:
    "Разбор КЛИЕНТСКОЙ БАЗЫ одним ответом на сейчас: сколько всего клиентов, сколько в работе (покупатели/продавцы), " +
    "сколько без контакта больше суток и ждут принятия, сколько не в работе и почему (сделка закрыта, Архив, работа " +
    "завершена и ждёт руководителя), заявки на удаление, отказы «Без сделки» за 30 дней с причинами, Корзина с " +
    "причинами; руководству — ещё по агентам. Зови на «сколько у нас клиентов», «сколько активных/неактивных», " +
    "«почему неактивны», «разбор базы», «ҳамагӣ чанд мизоҷ дорем», «чанд нафар фаъол». Статусов «активный/неактивный» " +
    "в CRM нет: «неактивные» = не в работе + без контакта, объясняй словами из meaning. Числа бери ровно из display. " +
    "Агенту — только его клиенты. Конкретные фамилии клиентов без контакта — get_unworked.",
  parameters: { type: "object", properties: { lang: LANG_PROP } },
  allowed: (actor) => !inGroup(actor),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return { error: "Это — только в личном чате с Шабнам" };
    const parsed = argsSchema.safeParse(raw ?? {});
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const ownAgentId = actor.canViewAllClients ? undefined : actor.id;
    const overview = await loadClientBaseOverview({
      ownAgentId,
      canDelete: has(actor, "clients.delete"),
      canOther: has(actor, "otherInquiries.view"),
    });
    return {
      period: tr(lang, `на ${overview.asOf} (по Душанбе); отказы и Корзина — за ${overview.windowLabel}`,
        `то ${overview.asOf} (вақти Душанбе); радҳо ва Сабад — дар ${overview.windowLabel}`),
      scope: overview.scope === "own" ? "только ваши клиенты" : "вся компания",
      overview,
      meaning: MEANING,
      display: renderClientBaseOverview(overview, lang),
    };
  },
};
