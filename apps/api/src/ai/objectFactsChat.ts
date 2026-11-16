import type { ChatMessage } from "./client.js";
import { findOffCatalogClaims, stripOffCatalogStreets } from "./catalogClaimsGuard.js";
import { guardRenovationClaims, placeAskAgentReply } from "./objectFactsGuard.js";

/**
 * МЕСТО И СОСТОЯНИЕ ОБЪЕКТА В ОТВЕТЕ ЧАТА — ОДНО ПОДКЛЮЧЕНИЕ СТОРОЖЕЙ (16.11.2026, аудит facts.md
 * Ф2/Ф3; ревью #207 С6). Вынесено из ai/leadQualifier.ts::runQualifyTurn, чтобы проверять тестом
 * не только сторожей по отдельности, но и то, как они стоят в ходе: порядок, источники, замена
 * вырезанного ответа.
 *
 *  1. Улица/ориентир (catalogClaimsGuard, таджикские формы): сверка с подборкой (там адрес и
 *     ориентир карточек), картой мест из слов клиента и прошлыми репликами бота — НЕ со
 *     справочником народных названий («Зарафшон» и «Лучоб» настоящие, но объект не там).
 *     Фраза с выдумкой вырезается; было «только журнал» с 10.10 — за 7 дней до 16.11 три живые
 *     выдумки и ноль записей.
 *  2. «С ремонтом» — только про объект, у которого ремонт в карточке (objectFactsGuard).
 *  3. Ничего не осталось — честное «точное место и состояние скажет агент».
 * Площадь и этаж вне подборки — по-прежнему только находка для журнала.
 */
export function applyObjectFactGuards(input: {
  reply: string[];
  propsBlock: string;
  geoBlock: string;
  folkGeography: string;
  history: ChatMessage[];
  usdToTjs?: number;
  language: string;
}): {
  reply: string[];
  /** Ответ после сторожа места — для следа хода. */
  afterPlace: string[];
  streets: string[];
  areas: number[];
  floors: number[];
  renovationRemoved: number;
} {
  const { propsBlock, geoBlock, history } = input;
  const claims = findOffCatalogClaims({
    text: input.reply.join("\n"),
    allowedText: propsBlock + "\n" + history.map((m) => m.content).join("\n"),
    catalogText: `${propsBlock}\n${geoBlock}\n${input.folkGeography}`,
    clientText: history
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n"),
    usdToTjs: input.usdToTjs,
    tajikPlaces: true,
    placeSources: `${propsBlock}\n${geoBlock}\n${history
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("\n")}`,
  });
  let reply = input.reply;
  if (claims.streets.length > 0) {
    const kept = stripOffCatalogStreets(reply, claims.streets);
    reply = kept.length > 0 ? kept : [placeAskAgentReply(input.language)];
  }
  const afterPlace = reply;
  const renovation = guardRenovationClaims(reply, propsBlock);
  if (renovation.removed > 0) {
    reply = renovation.bubbles.length > 0 ? renovation.bubbles : [placeAskAgentReply(input.language)];
  }
  return {
    reply,
    afterPlace,
    streets: claims.streets,
    areas: claims.areas,
    floors: claims.floors,
    renovationRemoved: renovation.removed,
  };
}
