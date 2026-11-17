import { z } from "zod";
import { ALWAYS_ON_KINDS, PUSH_KINDS, isMutablePushKind, isReadOnlyRole } from "@royal-home/shared";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { kindLabel, mutedKindsOf, setKindMuted } from "../../../lib/notificationPrefs.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * set_notification_pref — «НЕ ПРИСЫЛАЙ МНЕ ТАКОЕ» СЛОВАМИ МОДЕЛИ (14.11.2026, аудит Шабнам).
 *
 * Было: разбор фразы (telegram/staffNotice.ts::parseNoticeIntent) понимал узкий
 * список оборотов, а на «перестань присылать оплаты» модель отвечала «хорошо,
 * больше не буду» — и ничего не менялось. Теперь вид и направление решает модель
 * аргументами инструмента, а код проверяет и пишет через ту же одну дверь
 * отключений (lib/notificationPrefs.ts::setKindMuted), что кнопка «🔕 Не
 * присылать такое», тумблеры профиля и push. Регулярка в staffNotice остаётся
 * быстрым путём без модели.
 *
 * Карточка подтверждения — общая карточка брокера, как у любого изменения из
 * помощника (кнопка «Подтвердить», откат «Отменить»), в CRM и в личке Telegram.
 * В общей группе не объявляется: настройка личная.
 * Безопасность (ALWAYS_ON_KINDS) не выключается: отказ с причиной ещё до карточки.
 */
const KIND_KEYS = [...PUSH_KINDS.map((k) => k.key), ...ALWAYS_ON_KINDS.map((k) => k.key)] as [string, ...string[]];

const argsSchema = z.object({
  kind: z.enum(KIND_KEYS),
  // Модель иногда шлёт булево строкой — принимаем, как форма.
  muted: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]),
});
type Args = z.infer<typeof argsSchema>;

interface Snap {
  kind: string;
  muted: boolean;
  [extra: string]: unknown;
}

function assertSwitchable(kind: string): void {
  const always = ALWAYS_ON_KINDS.find((k) => k.key === kind);
  if (always) throw new AssistantActionError(422, "ALWAYS_ON", `«${always.label}» выключить нельзя. ${always.why}`);
  if (!isMutablePushKind(kind)) throw new AssistantActionError(422, "UNKNOWN_KIND", "Такого вида уведомлений нет");
}

export const notificationPrefExecutor: AssistantActionExecutor<Args> = {
  tool: "set_notification_pref",
  channels: ["crm", "telegram"],
  // Личная настройка: в общей группе чужие глаза и чужие кнопки.
  privateTelegram: true,
  parseArgs: (raw) => argsSchema.parse(raw),

  async snapshot(args, actor): Promise<Snap> {
    assertSwitchable(args.kind);
    return { kind: args.kind, muted: (await mutedKindsOf(actor.agentId)).includes(args.kind) };
  },

  buildPreview(args, raw) {
    const snap = raw as Snap;
    const label = kindLabel(args.kind);
    const state = (muted: boolean) => (muted ? "не приходят" : "приходят");
    return {
      title: args.muted ? `🔕 Не присылать: «${label}»` : `🔔 Снова присылать: «${label}»`,
      was: { [label]: state(snap.muted) },
      becomes: { [label]: state(args.muted) },
      risk: args.muted
        ? "Перестанет приходить в Telegram и на телефон. Включить обратно — «включи обратно …» или в профиле CRM → «Что присылать мне»."
        : "Снова будет приходить в Telegram и на телефон.",
    };
  },

  async execute(args, actor) {
    const result = await setKindMuted(actor.agentId, args.kind, args.muted);
    if (!result.ok) {
      throw new AssistantActionError(422, result.reason === "always-on" ? "ALWAYS_ON" : "UNKNOWN_KIND",
        result.reason === "always-on" ? `«${result.label}» выключить нельзя. ${result.why}` : "Такого вида уведомлений нет");
    }
    const label = kindLabel(args.kind);
    return {
      result: { kind: args.kind, muted: args.muted, changed: result.changed, message: args.muted ? `Выключено: «${label}»` : `Снова приходит: «${label}»` },
      audit: { entityType: "Agent", entityId: actor.agentId },
    };
  },

  async undo(args, actor) {
    await setKindMuted(actor.agentId, args.kind, !args.muted);
  },
};

const kindList = [
  ...PUSH_KINDS.map((k) => `${k.key} — ${k.label} (${k.hint})`),
  ...ALWAYS_ON_KINDS.map((k) => `${k.key} — ${k.label} (выключить нельзя)`),
].join("; ");

export const notificationPrefPlugin: AssistantWriteToolPlugin = {
  name: "set_notification_pref",
  level: "C",
  description:
    "Выключить или снова включить человеку ОДИН вид его уведомлений (Telegram и телефон) — личная настройка «Что присылать мне». " +
    "Звать, когда человек говорит о СВОИХ уведомлениях любыми словами: «не присылай мне оплаты», «перестань присылать оплаты», " +
    "«эти уведомления мне не нужны», «не беспокой по оплатам», «ин паёмҳо ба ман даркор нест», «инро хомӯш кун», " +
    "«включи обратно задачи», «снова присылай показы». Вид бери из слов или из уведомления, о котором речь в разговоре; " +
    "не ясен — спроси, какой, и не зови. НЕ звать для дел («не отправляй заявку Нозе», «не пиши клиенту», «верни объект»). " +
    "Без вызова этого инструмента НЕ говори «выключила», «больше не пришлю». После вызова одной фразой попроси подтвердить.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...KIND_KEYS], description: `Вид уведомлений: ${kindList}.` },
      muted: { type: "boolean", description: "true — выключить (не присылать), false — включить обратно." },
    },
    required: ["kind", "muted"],
  },
  statusPhrase: "Готовлю настройку уведомлений…",
  // Нажать «Подтвердить» в Telegram может только не-наблюдатель (assistantBot отказывает акционеру);
  // наблюдателю остаются кнопка «🔕 Не присылать такое» и профиль CRM.
  allowed: (actor) => actor.surface !== "telegram-group" && !isReadOnlyRole(actor.role),
  executor: notificationPrefExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
