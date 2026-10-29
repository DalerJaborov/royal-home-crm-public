import type { CustomerAgentSayDropReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { traceGuardHit } from "../lib/botTurnTrace.js";
import { dushanbeDateString, dushanbeWallClock } from "../lib/dushanbeTime.js";

/**
 * СЧЁТЧИКИ СРАБАТЫВАНИЯ ФИЛЬТРОВ ОТВЕТА (совет экспертов 26.08, пункт 8).
 *
 * Восемь с лишним фильтров молча чинят реплики бота перед отправкой: убирают
 * повторное приветствие, вырезают дубль ссылки на объект, глушат обещания
 * наличия, подчищают повторяющиеся вопросы. Сколько раз каждый из них сработал
 * за сутки, не знал никто — а это и есть прямая мера того, насколько промт
 * расходится с желаемым поведением. Правку промта выкатывали и надеялись.
 *
 * Дёшево: одна строка в сутки на фильтр, upsert с инкрементом. Никаких новых
 * вызовов ИИ, никакого влияния на ответ — только наблюдение.
 *
 * Fire-and-forget по контракту: счётчик не имеет права задержать или уронить
 * ответ клиенту. Отказ базы гасится в консоль.
 */

/** Ключи фиксированы: по ним строится таблица на экране «Обучение бота». */
export type GuardName =
  | "repeat_greeting"
  | "repeated_question"
  | "duplicate_card_link"
  | "availability_promise"
  | "discount_percent"
  | "price_range"
  | "emoji_in_direct"
  | "off_topic"
  /*
   * ФИЛЬТРЫ НЕЦЕЛЕВЫХ ЛИДОВ (30.08.2026). Тип карточки решает КОД, а не промт:
   * запрет, стоящий только в тексте промта, — просьба, а не гарантия. Раз решение
   * принимает код, оно обязано и считаться здесь, иначе на экране «Обучение бота»
   * видно восемь старых фильтров и ни одного нового.
   */
  | "coverage"
  | "service_offer"
  | "asset_scope"
  | "agency_pitch"
  | "recruiting_off_topic"
  | "photo_ack_repeat"
  | "ack_only"
  | "bare_share_repeat"
  | "bot_repeat"
  /*
   * НАКРУТКА ПОВТОРНОЙ ПЕРЕСЫЛКОЙ НЕРАСПОЗНАННОГО ВИДЕО (30.08.2026, лид
   * «Муродали») — см. ai/replyRepeatGuard.ts, countUnresolvedShareReplies.
   */
  | "unresolved_share_repeat"
  /*
   * РАЗБОР НАХОДОК СУДЬИ 30.08.2026 (BotAuditFinding): «строго 1 вопрос в 1
   * сообщении» и запрещённые слова из <language_and_slang> — тоже правила,
   * которые до сих пор были только в промте, а находки показали живые случаи
   * нарушения. См. ai/oneQuestionGuard.ts и ai/bannedWordsGuard.ts.
   */
  | "two_questions"
  | "banned_word"
  /*
   * ПРИШЁЛ ПО РЕКЛАМЕ И НИЧЕГО НЕ НАПИСАЛ (17.09.2026) — click-to-WhatsApp
   * подставляет готовую фразу, и лид заводился по нажатию кнопки, с выдуманными
   * районом и бюджетом. См. ai/adTemplateOpener.ts и ai/leadKind.ts.
   */
  | "ad_no_words"
  /*
   * ОБРАЩЕНИЕ НЕ ПРО НЕДВИЖИМОСТЬ ДОШЛО ДО КАРТОЧКИ (17.09.2026, ПК-000330) —
   * `looksLikeMoneyRequest` обычно ловит такие сообщения раньше, полным
   * молчанием (ai/moneyRequestGuard.ts); этот счётчик — та же проверка ВТОРЫМ
   * рубежом, внутри decideLeadKind (ai/leadKind.ts), на случай, когда карточка
   * уже создана. Отдельный ключ от «money» в ScreenResult (ai/inboundScreen.ts):
   * тот про ответ бота, этот — про тип уже существующей карточки.
   */
  | "money_request_card"
  /*
   * НАВОДЯЩИЙ ВОПРОС ПРО НАПРАВЛЕНИЕ (21.09.2026, живой случай карточка №104):
   * бот сам спросил «Шумо ин хонаро мефурӯшед?», хотя клиент ни разу не назвал
   * направление словами, — вопрос подменяется на нейтральный (см.
   * ai/intentDirectionGuard.ts::guardDirectionQuestion).
   */
  | "direction_question"
  /* Клиент назвал себя хозяином, а бот говорил о собственнике как о третьем лице
   * (28.09.2026, ai/intentDirectionGuard.ts::guardOwnerAsThirdParty). */
  | "owner_as_third_party"
  /*
   * НАПРАВЛЕНИЕ ТАК И НЕ ПОДТВЕРЖДЕНО СЛОВАМИ КЛИЕНТА К МОМЕНТУ ЗАВОДА КАРТОЧКИ
   * (21.09.2026, тот же разбор) — см. ai/leadKind.ts.
   */
  | "direction_unconfirmed"
  | "direction_conflict"
  /*
   * ЩИТ ИСХОДЯЩИХ (17.09.2026) — единственный «фильтр», который не правит текст,
   * а не выпускает сообщение наружу вовсе. Считается здесь же, чтобы на пульте и
   * на экране «Обучение бота» было видно, сколько раз бот был остановлен и, если
   * счётчик пополз, чтобы это заметили раньше владельца. См. lib/outboundShield.ts.
   */
  | "outbound_shield"
  /*
   * МОДЕЛЬ ПРИДУМАЛА ПРОСЬБУ О ЗВОНКЕ (22.09.2026, продавец дачи в WhatsApp): бот
   * сам попросил номер «то агенти мо занг занад», клиент прислал номер — и поле
   * callbackRequest оказалось заполнено, хотя человек о звонке не просил. Порог
   * решает код по словам клиента (ai/operatorHandoff.ts), а счётчик показывает,
   * как часто модель это придумывает.
   */
  | "callback_not_asked"
  /*
   * КАТЕГОРИЯ ИЗ ДОСЬЕ РЕШИЛА ТИП КАРТОЧКИ (§10.4, 22.09.2026) — этот ход сам
   * неуверен (`confident=false`/намерения нет), и код взял BUYER/SELLER из
   * накопленной категории `ContactProfile`, а не оставил карточку «Прочей».
   * Считается только при включённом `Settings.contactCategoryDrivesLeadKind`.
   * См. ai/leadKind.ts::kindFromPriorCategory.
   */
  | "category_primary_source"
  /*
   * БОТ НЕ МОЛЧИТ ИЗ-ЗА СВОИХ ЖЕ ФИЛЬТРОВ (аудит ботов 10.10.2026, P0-1): ответ
   * модели целиком вырезали стражи или он оказался повтором — модель отвечает
   * второй раз с поправкой, а если и это пусто, клиенту уходит короткая
   * нейтральная реплика. Счётчики показывают, как часто это случается (цель —
   * чтобы оба ползли вниз). См. messengers/replyChain.ts::finalizeBotReply.
   */
  | "reply_regenerated"
  | "reply_neutral_fallback"
  /*
   * ЖИВАЯ ФРАЗА МОДЕЛИ (`say`, 24.10.2026, ai/customerAgentSay.ts): принята целиком или отброшена целиком с кодом причины.
   * `say_dropped_shadow` — фраза прошла проверку, но режим «тень» её не отправил (считаем, как часто она была бы годной).
   */
  | "say_used"
  | `say_dropped_${CustomerAgentSayDropReason}`;

/**
 * ПОДПИСИ ДЛЯ ЭКРАНА «ОБУЧЕНИЕ БОТА» — по-русски и в одном месте.
 *
 * Ключи фильтров латинские (они лежат в базе, в GuardHit.guard), и без словаря на
 * экран попадали бы сырые `service_offer` и `bot_repeat`. Ровно на этом уже
 * спотыкался журнал заявок на удаление. Подпись отдаёт сервер (routes/botTraining.ts),
 * а не веб: ключ и его человеческое имя не должны разъезжаться по двум приложениям.
 */
export const GUARD_LABELS: Record<GuardName, string> = {
  repeat_greeting: "Повторное приветствие",
  repeated_question: "Переспрошенный вопрос",
  duplicate_card_link: "Дубль ссылки на объект",
  availability_promise: "Обещание наличия",
  discount_percent: "Обещание скидки",
  price_range: "Вилка цены",
  emoji_in_direct: "Смайлики в Директе",
  off_topic: "Разговор не по делу",
  coverage: "География — не Душанбе",
  service_offer: "Услуги и поиск работы",
  asset_scope: "Земля и коммерция — не наш профиль",
  agency_pitch: "Реклама площадок нам как агентству",
  recruiting_off_topic: "Про найм агентов не кандидату",
  photo_ack_repeat: "Повторное «фото получили» на новую пачку фото",
  ack_only: "«Ок/рахмат» без вопроса бота — только реакция",
  bare_share_repeat: "Третий пересланный ролик подряд без слов — молчание",
  bot_repeat: "Дословный повтор реплики бота",
  unresolved_share_repeat: "Повтор нераспознанного пересланного видео",
  two_questions: "Два вопроса в одном сообщении",
  banned_word: "Запрещённое слово из правил языка",
  ad_no_words: "Реклама: человек не написал ничего своего",
  money_request_card: "Просьба о помощи дошла до карточки (не по теме)",
  direction_question: "Наводящий вопрос про покупку/продажу заменён на нейтральный",
  owner_as_third_party: "Собственнику ответили как покупателю — заменено на «передам агенту объекта»",
  direction_unconfirmed: "Направление не подтверждено словами клиента — агенту пометка «уточнить»",
  direction_conflict: "Слова клиента противоречат направлению модели — агенту пометка «уточнить», не в «Прочие»",
  outbound_shield: "Щит исходящих остановил сообщение бота",
  callback_not_asked: "Просьба о звонке придумана моделью — клиент о нём не просил",
  category_primary_source: "Тип карточки взят из категории досье (ход сам неуверен)",
  reply_regenerated: "Ответ съели фильтры — модель ответила второй раз",
  reply_neutral_fallback: "Ответ съели фильтры — ушла короткая нейтральная реплика",
  say_used: "Живая фраза бота ушла клиенту",
  say_dropped_surface_disabled: "Живая фраза отброшена: не личные сообщения",
  say_dropped_language_disabled: "Живая фраза отброшена: язык ещё не включён (таджикский)",
  say_dropped_length: "Живая фраза отброшена: длина, число предложений или перенос строки",
  say_dropped_question: "Живая фраза отброшена: вопрос или просьба написать",
  say_dropped_number_or_date: "Живая фраза отброшена: цифра, сумма, дата или срок",
  say_dropped_contact: "Живая фраза отброшена: контакт, ссылка, латиница или просьба номера",
  say_dropped_promise: "Живая фраза отброшена: обещание или будущее действие",
  say_dropped_fact_claim: "Живая фраза отброшена: утверждение о наличии, цене или условиях",
  say_dropped_place: "Живая фраза отброшена: место, которое клиент не называл",
  say_dropped_meta: "Живая фраза отброшена: служебные слова или самораскрытие",
  say_dropped_cliche: "Живая фраза отброшена: ИИ-штамп",
  say_dropped_language: "Живая фраза отброшена: не тот язык или смесь языков",
  say_dropped_echo: "Живая фраза отброшена: дословный повтор слов клиента",
  say_dropped_repeat: "Живая фраза отброшена: повтор прежней реплики бота",
  say_dropped_double_greet: "Живая фраза отброшена: второе приветствие",
  say_dropped_shadow: "Живая фраза годная, но режим «тень» её не отправил",
};

export function guardFired(name: GuardName, times = 1): void {
  traceGuardHit(times);
  if (times <= 0) return;
  // Сутки — по Душанбе: контейнер живёт в UTC, и «за сегодня» на экране должно
  // означать местный день, а не окно, съезжающее на пять часов.
  const day = dushanbeWallClock().toISOString().slice(0, 10);
  void prisma.guardHit
    .upsert({
      where: { day_guard: { day, guard: name } },
      update: { count: { increment: times } },
      create: { day, guard: name, count: times },
    })
    .catch((err) => {
      console.error("[guards] счётчик не записан:", err instanceof Error ? err.message : err);
    });
}

export interface GuardDayRow {
  day: string;
  guard: string;
  count: number;
}

/** Срабатывания за последние `days` суток — для экрана «Обучение бота». */
export async function loadGuardStats(days = 14): Promise<GuardDayRow[]> {
  // Ключи дней — по Душанбе (guardFired выше), значит и граница тоже: по UTC с 00:00
  // до 05:00 по Душанбе окно захватывало лишние сутки (ночная проверка 01.10.2026, №175).
  const from = dushanbeDateString(new Date(Date.now() - days * 86400000));
  return prisma.guardHit.findMany({
    where: { day: { gte: from } },
    orderBy: [{ day: "desc" }, { count: "desc" }],
    take: 500,
  });
}
