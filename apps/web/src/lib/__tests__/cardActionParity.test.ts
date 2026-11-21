import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ДЕЙСТВИЯ КАРТОЧЕК: ПК = ТЕЛЕФОН АГЕНТА (17.11.2026, аудит интерфейса F1-1/F1-2).
 *
 * Агент на телефоне ВСЕГДА получает старую оболочку (hooks/shellDevicePolicy.ts:
 * `mobile && role==="AGENT"` → чистая оболочка запрещена), а карточки клиента и
 * объекта там рисуются отдельными компонентами — MobileClientCard и
 * LegacyAgentPropertyView. Новое действие, добавленное только в разметку ПК, на
 * телефоне агента молча отсутствует: ничего не падает и не предупреждает.
 * Так уже было трижды: красные флаги «Надзора» (22.08 и 30.08), «Написать в
 * WhatsApp первыми» в карточке клиента и «Поделиться / Назначить показ / Отчёт
 * владельцу» в карточке объекта (найдено аудитом 17.11).
 *
 * Сторож держит СПИСОК ОБЯЗАТЕЛЬНЫХ ДЕЙСТВИЙ одним массивом и проверяет, что
 * каждое есть в обоих файлах. Добавили действие на ПК — допишите строку сюда, и
 * сторож потребует его и на телефоне. Действие намеренно только для ПК — оно
 * сюда не вписывается, а в комментарии рядом с ним сказано почему.
 *
 * Маркер — либо имя общего компонента (`<Имя`), либо подпись кнопки между
 * тегами (`>Подпись<`) или строкой (`"Подпись"`). Комментарии вырезаются: упоминание
 * компонента словами в пояснении — не действие на экране.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Marker = { component: string } | { text: string };
interface CardAction {
  id: string;
  /** Как действие называется для человека — попадает в текст ошибки. */
  label: string;
  marker: Marker;
}
interface CardParity {
  card: string;
  desktop: string;
  agentPhone: string;
  actions: CardAction[];
}

const CARD_ACTION_PARITY: CardParity[] = [
  {
    card: "Карточка клиента",
    desktop: "pages/ClientDetail.tsx",
    agentPhone: "components/mobile/MobileClientCard.tsx",
    actions: [
      { id: "call", label: "Позвонить", marker: { component: "CallPhoneChooser" } },
      { id: "write", label: "Написать", marker: { text: "Написать" } },
      { id: "match", label: "Подбор", marker: { text: "Подбор" } },
      { id: "whatsapp-first", label: "Написать в WhatsApp первыми", marker: { component: "WhatsAppFirstContact" } },
      { id: "more", label: "Ещё (редкие действия)", marker: { component: "ClientMoreMenu" } },
      { id: "history", label: "История", marker: { component: "InteractionTimeline" } },
      // Объявления с площадок под покупателем: WhatsApp продавцу, «Показать номер», ссылка, отметка «уже связывались» (17.11.2026).
      { id: "market-listings", label: "С площадок (объявления под покупателя)", marker: { component: "MarketBuyerListings" } },
    ],
  },
  {
    card: "Карточка объекта",
    desktop: "pages/PropertyDetail.tsx",
    agentPhone: "components/mobile/LegacyAgentPropertyView.tsx",
    actions: [
      { id: "share", label: "Поделиться ссылкой", marker: { component: "PropertyShareLink" } },
      { id: "showing", label: "Назначить показ", marker: { component: "ShowingQuickForm" } },
      { id: "owner-report", label: "Отчёт владельцу", marker: { component: "OwnerReportCard" } },
      { id: "photos", label: "Фотографии", marker: { component: "PropertyPhotoManager" } },
      { id: "video", label: "Видео", marker: { component: "PropertyClipVideoCard" } },
      { id: "stats", label: "Статистика", marker: { component: "PropertyStatsCard" } },
      { id: "history", label: "История", marker: { component: "PropertyHistoryCard" } },
      { id: "demand", label: "Покупатели ждут", marker: { component: "DemandLine" } },
    ],
  },
];

function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Какие действия из списка в исходнике не нашлись. */
function missingActions(source: string, actions: CardAction[]): string[] {
  const code = stripComments(source);
  return actions
    .filter(({ marker }) => {
      const re =
        "component" in marker
          ? new RegExp(`<${escapeRe(marker.component)}[\\s/>]`)
          : // Подпись между тегами или строкой в JSX-выражении: {canBuy ? "Подбор" : "Объекты"}.
            new RegExp(`>\\s*${escapeRe(marker.text)}\\s*<|"${escapeRe(marker.text)}"`);
      return !re.test(code);
    })
    .map((a) => a.label);
}

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("действия карточек: ПК = телефон агента", () => {
  for (const parity of CARD_ACTION_PARITY) {
    it(`${parity.card}: каждое действие есть на ПК (список не врёт)`, () => {
      expect(missingActions(read(parity.desktop), parity.actions)).toEqual([]);
    });
    it(`${parity.card}: каждое действие ПК есть и на телефоне агента`, () => {
      expect(missingActions(read(parity.agentPhone), parity.actions)).toEqual([]);
    });
  }

  it("сторож краснеет, если действие есть только на ПК (поломка нарочно)", () => {
    const actions: CardAction[] = [
      { id: "a", label: "Поделиться ссылкой", marker: { component: "PropertyShareLink" } },
      { id: "b", label: "Написать", marker: { text: "Написать" } },
    ];
    // Упоминание в комментарии — не кнопка на экране.
    const phoneWithoutActions = `{/* <PropertyShareLink property={p} /> */}\n// <button>Написать</button>\n<div />`;
    expect(missingActions(phoneWithoutActions, actions)).toEqual(["Поделиться ссылкой", "Написать"]);
    const phoneWithActions = `<PropertyShareLink property={p} />\n<button>\n  Написать\n</button>`;
    expect(missingActions(phoneWithActions, actions)).toEqual([]);
  });
});
