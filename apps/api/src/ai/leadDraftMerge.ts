import type { ChannelTurnResult } from "./channelTurnResult.js";
import type { LeadIntent } from "./botContract.js";
import type { LeadDraft } from "./leadDraft.js";
import { MIN_REAL_PURCHASE_TJS } from "./moneyThresholds.js";
import { looksLikeBuyOrSellRequest, looksLikeRentBudget, looksLikeRentRequest } from "./rentGuard.js";

// The lead draft of a customer conversation, merged turn by turn. Moved out of the deleted old bot (ai/leadQualifier.ts)
// without a change in behaviour, one brain step 3b (16.11.2026); the turn result now comes from the core channel adapter.

/**
 * Сливает результат хода модели в накопленный черновик (новые поля не затирают уже известные null'ами).
 *
 * @param clientText слова КЛИЕНТА на этом ходе — по ним код сам решает, не про
 *   аренду ли разговор (ai/rentGuard.ts). Решение кода сильнее решения модели:
 *   запрет на аренду стоит и в промте, но однажды модель написала «иҷора надорем»
 *   и тут же выставила intent=buy, и живой агент получил арендатора как покупателя.
 */
export function mergeDraft(draft: LeadDraft, result: ChannelTurnResult, clientText?: string): LeadDraft {
  const text = clientText ?? "";
  const locationOutsideDushanbe = result.lead?.locationOutsideDushanbe ?? draft.locationOutsideDushanbe;
  const locationDifferentCountry = result.lead?.locationDifferentCountry ?? draft.locationDifferentCountry;
  const rawMin = result.lead?.budgetMin ?? draft.budgetMin;
  const rawMax = result.lead?.budgetMax ?? draft.budgetMax;
  // Верхняя граница ниже порога — вся вилка нереальна: обе границы отбрасываем.
  const unrealistic = typeof rawMax === "number" && rawMax > 0 && rawMax < MIN_REAL_PURCHASE_TJS;
  const budgetMin = unrealistic ? undefined : rawMin;
  const budgetMax = unrealistic ? undefined : rawMax;
  /**
   * Аренду распознаёт КОД по словам клиента и переопределяет модель. ЛИПНЕТ к
   * разговору, пока клиент сам не заговорит о купле-продаже (владелец
   * 21.08.2026, разбор живого случая): без этого следующий пустой или
   * нейтральный ход («Раҳмат») отдавался модели как обычно, а она снова
   * классифицировала диалог как buy — draft.intent молча слетал с "rent", и
   * бот после верного отказа начинал спрашивать арендатора про район и число
   * комнат для покупки. Слетает только на явном «тогда куплю» —
   * looksLikeBuyOrSellRequest, тот же признак, что снимает отказ в
   * looksLikeRentRequest.
   */
  /**
   * ВТОРОЙ ПРИЗНАК АРЕНДЫ — СУММА (решение владельца 03.09.2026, см.
   * looksLikeRentBudget в ai/rentGuard.ts). Слова «иҷора» может не быть вовсе:
   * «2 хуҷрага бо нархи аз 3000 то 4500» — это месячная плата, и разговор про
   * аренду с первой минуты. Отсечка та же, что по слову, поэтому и метка та же.
   */
  const rentByBudget = unrealistic && looksLikeRentBudget(rawMax, text);
  /**
   * Настоящий бюджет снимает липкую метку наравне со словами о покупке: человек
   * сказал «3000–4500», бот переспросил про валюту, человек ответил «доллар» —
   * и в черновике появилась реальная вилка. Без этого он остался бы арендатором
   * до конца разговора и получил бы отказ вместо квартиры.
   */
  const realisticBudgetNow = typeof budgetMax === "number" && budgetMax >= MIN_REAL_PURCHASE_TJS;
  const intent: LeadIntent | undefined =
    (text && looksLikeRentRequest(text)) || rentByBudget
      ? "rent"
      : draft.intent === "rent" && !(text && looksLikeBuyOrSellRequest(text)) && !realisticBudgetNow
        ? "rent"
        : (result.intent ?? draft.intent);
  /**
   * Уверенность НЕ ЛИПНЕТ к разговору, в отличие от аренды: человек начал с
   * невнятного «салом, хона», а через три хода назвал район и бюджет — это
   * обычный покупатель, и одно давнее «не понял» не должно держать его в
   * «Прочих» до конца разговора. Берём ответ ЭТОГО хода, и только когда поля в
   * ответе не было вовсе — прежнее значение.
   */
  const confident = result.confident ?? draft.confident;
  /**
   * КТО ПИШЕТ — держится, пока модель не скажет иное, но НЕ МОЖЕТ пересилить
   * намерение.
   *
   * Держится потому, что в следующем ходе модель про это поле легко промолчит, а
   * рекламный агент не перестаёт им быть от одного невнятного сообщения:
   * потеряв метку, он снова получил бы интейк и вопрос «вам купить или продать?».
   * Не пересиливает потому, что цена ошибки несимметрична: покупателя, разок
   * помеченного как VENDOR, сценарий отказа выпроводил бы из переписки навсегда.
   * Поэтому свой сценарий и суженные права действуют только пока намерения нет
   * (см. coreRulesForIntent и abilitiesForIntent) — стоит модели поставить
   * intent=buy, и дальше ведёт покупатель. Ошибочная метка, кроме того, видна и
   * правится руками в панели собеседника («Чаты» → «Исправить»).
   */
  const whoIsThis = result.whoIsThis ?? draft.whoIsThis;
  return {
    ...draft,
    intent,
    confident,
    whoIsThis,
    /**
     * Одна названная сумма — ПОТОЛОК, а не точная цена. Услышав «то 700 ҳазор»,
     * модель нередко ставит её в обе границы, и из такого черновика в карточку
     * приходит вилка 700 000–700 000. Подбор берёт её с допуском ±10%
     * (routes/clients.ts, GET /:id/match) — и клиент с потолком 700 000 перестаёт
     * видеть квартиры за 500 000, которым был бы только рад. Нижнюю границу
     * оставляем, когда она РАЗНАЯ, то есть клиент действительно назвал вилку.
     */
    budgetMin: budgetMin === budgetMax ? undefined : budgetMin,
    budgetMax,
    /**
     * Улика аренды без слова «аренда» (см. поле в LeadDraft): в бюджет сумма не
     * годится, но тип обращения решается по ней.
     *
     * СНИМАЕТСЯ, КАК ТОЛЬКО ПОЯВИЛСЯ НАСТОЯЩИЙ БЮДЖЕТ. Бот на «3000–4500»
     * переспрашивает «ин ба доллар аст ё ҳазор сомонӣ?» — и человек, ответивший
     * «доллар», это обычный покупатель. Если бы улика липла навсегда, его
     * карточка так и уехала бы в «Прочие» с пометкой про аренду.
     */
    budgetUnrealistic: unrealistic ? rawMax : budgetMax ? undefined : draft.budgetUnrealistic,
    // Схема инструмента не позволяет модели явно передать districtName=null (только
    // один из 4 душанбинских районов или пропуск поля) — а пропуск сливается со старым
    // значением. Если клиент переключился на "вне Душанбе", старый район (например,
    // случайно названный до уточнения города) больше не актуален — сбрасываем сами.
    districtName:
      locationOutsideDushanbe || locationDifferentCountry
        ? undefined
        : (result.lead?.districtName ?? draft.districtName),
    type: result.lead?.type ?? draft.type,
    rooms: result.lead?.rooms ?? draft.rooms,
    // Названная сумма не теряется, даже если в поля бюджета она не годится: агент
    // должен видеть, ЧТО именно сказал человек, и уточнить это по телефону.
    notes: unrealistic
      ? [result.lead?.notes ?? draft.notes, `БЮДЖЕТ УТОЧНИТЬ: клиент назвал ${rawMin ?? "?"}–${rawMax} — похоже на описку или на аренду`]
          .filter(Boolean)
          .join(". ")
      : (result.lead?.notes ?? draft.notes),
    locationOutsideDushanbe,
    locationDifferentCountry,
    // Договорённость о показе не затирается пустым ходом: клиент назвал время один
    // раз, а дальше может ещё десять сообщений уточнять этаж — потерять её нельзя.
    pendingShowing: result.showing ?? draft.pendingShowing,
    // Объект за пределами страны и аренда — телефон не спрашиваем и заявку не
    // заводим (см. acceptLead в messengers/conversation.ts), поэтому
    // "awaiting_phone" здесь не наступает никогда, даже если модель ошибочно
    // прислала ready=true.
    //
    // ДРУГОЙ ГОРОД РТ — ТОЖЕ НЕ "awaiting_phone" (владелец 17.09.2026, живой разбор
    // диалогов). Заявку в этом случае берём (в отличие от locationDifferentCountry),
    // но НЕ обещаем звонок агента — а "awaiting_phone" именно это и делал: держал
    // ensurePhoneAskKept взведённым, и тот дописывал в отказ фразу "агенти мо бо
    // Шумо тамос мегирад" (phoneReminder, ai/replyGuards.ts), хотя промт двумя
    // строками ниже прямо запрещает такие обещания. Телефон, оставленный клиентом
    // самим, всё равно ловится ниже по стеку (extractVolunteeredPhone) — без
    // "awaiting_phone" код просто перестаёт САМ его выпрашивать и клянчить звонком.
    stage:
      result.ready && !locationDifferentCountry && !locationOutsideDushanbe && intent !== "rent"
        ? "awaiting_phone"
        : "chatting",
  };
}

/**
 * «ЛИЧНОСТЬ» БОТА — ТЕКСТ ВЛАДЕЛЬЦА.
 *
 * Это НЕ источник правды: как только владелец сохранил свой текст в Настройках,
 * работает его текст, и код сюда больше не вмешивается никогда. Константа нужна
 * ровно для двух вещей — первое наполнение поля в интерфейсе и работа бота, пока
 * в Настройках пусто.
 *
 * Поэтому здесь ТОЛЬКО то, что владелец вправе переписать целиком: кто мы, к чему
 * ведём разговор, каким языком и какими словами. Всё, что терять нельзя, лежит
 * ниже в BOT_CORE_RULES и приклеивается независимо от этого текста.
 *
 * Топонимика Душанбе и сленг подготовлены с локальным экспертом (владельцем).
 */
/** Роль и цель ПРОДАЮЩЕГО бота — то, что у информационного аккаунта другое. */
