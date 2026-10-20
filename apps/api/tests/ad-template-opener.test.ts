import { describe, expect, it } from "vitest";
import { classifyAdTopic, clientSaidNothingSubstantive, isJobAdRef, isSellerAdRef } from "../src/ai/adTemplateOpener.js";
import { decideLeadKind } from "../src/ai/leadKind.js";

/**
 * «ПРИШЁЛ ПО РЕКЛАМЕ И НИЧЕГО НЕ НАПИСАЛ» (17.09.2026).
 *
 * Живой разбор: клиенты 302 (Шоира), 315 (Азиза), 319 (Томирис) пришли из
 * click-to-WhatsApp со ОДНОЙ подставленной фразой «Привет! Можно узнать об этом
 * подробнее?» и больше не написали ничего. CRM завела их покупателями с агентом,
 * у 302 — с выдуманными «3 комнаты, Сино, бюджет 231 750». Двое из троих на самом
 * деле откликались на вакансию. Владелец: «пусть сначала берёт информацию про
 * кандидата, а то кандидат ничего не написал, ИИ уже принял его как лид».
 */

describe("шаблонная фраза с рекламы — это не слова клиента", () => {
  const templates = [
    "Привет! Можно узнать об этом подробнее?",
    "Здравствуйте! Можно узнать об этом подробнее?",
    "привет можно узнать подробнее",
    "Salom! Метавонам дар бораи ин бештар донам?",
    "Hi! Can I get more info about this?",
    "Hello, I'm interested in this",
  ];
  for (const t of templates) {
    it(`«${t}» — своих слов нет`, () => {
      expect(clientSaidNothingSubstantive(t)).toBe(true);
    });
  }

  it("пустое сообщение и одно приветствие — тоже", () => {
    expect(clientSaidNothingSubstantive("")).toBe(true);
    expect(clientSaidNothingSubstantive(undefined)).toBe(true);
    expect(clientSaidNothingSubstantive("Салом алейкум!")).toBe(true);
    expect(clientSaidNothingSubstantive("Добрый день 👋")).toBe(true);
  });
});

describe("настоящие слова клиента шаблоном не считаются", () => {
  /** Ошибиться в эту сторону дороже: живой клиент остался бы без агента. */
  const real = [
    "Привет! Можно узнать об этом подробнее? 3 комнаты в Сино нужны",
    "Салом, хонаи 2 хуҷрагӣ доред?",
    "барои кор омадам",
    "Здравствуйте, сколько стоит эта квартира?",
    "Можно узнать подробнее про вакансию",
  ];
  for (const t of real) {
    it(`«${t}» — клиент сказал своё`, () => {
      expect(clientSaidNothingSubstantive(t)).toBe(false);
    });
  }
});

describe("decideLeadKind: реклама без слов клиента не даёт покупателя", () => {
  it("шаблон + intent=buy от модели → «прочее», агенту не уходит", () => {
    const d = decideLeadKind({
      intent: "buy",
      clientText: "Привет! Можно узнать об этом подробнее?",
      budgetMin: 200_000,
      budgetMax: 231_750,
      fromAd: true,
    });
    expect(d.kind).toBe("OTHER");
    expect(d.reason).toBe("реклама без слов клиента");
  });

  it("то же сообщение БЕЗ рекламы разбирается как раньше", () => {
    // Человек, написавший нам сам, — обычный разговор: отсечка касается только
    // подставленной кнопкой фразы.
    expect(decideLeadKind({ intent: "buy", clientText: "Можно узнать об этом подробнее?" }).kind).toBe("BUYER");
  });

  it("метка объявления сказала «вакансия» — сценарий работы сильнее отсечки", () => {
    const d = decideLeadKind({ intent: "job", clientText: "Привет! Можно узнать об этом подробнее?", fromAd: true });
    expect(d.kind).toBe("OTHER");
    expect(d.reason).toBe("работа");
  });

  it("клиент добавил свои слова — обычный покупатель, даже с рекламы", () => {
    const d = decideLeadKind({
      intent: "buy",
      clientText: "Привет! Можно узнать об этом подробнее? 3 хона дар Сино мекобам",
      fromAd: true,
    });
    expect(d.kind).toBe("BUYER");
  });
});

describe("метка объявления про вакансию", () => {
  it("ловит русский, английский и таджикский", () => {
    expect(isJobAdRef("vacancy_manager")).toBe(true);
    expect(isJobAdRef("Работа в Royal Home")).toBe(true);
    expect(isJobAdRef("Ҷои кор — менеджер")).toBe(true);
    expect(isJobAdRef("job")).toBe(true);
  });

  it("реклама квартиры вакансией не считается", () => {
    expect(isJobAdRef("z_55 Сино 3 комнаты")).toBe(false);
    expect(isJobAdRef("")).toBe(false);
    expect(isJobAdRef(null)).toBe(false);
  });
});

/**
 * ТИП РЕКЛАМЫ ПО ТАБЛИЦЕ Ad (25.09.2026, аудит «кто вообще кандидат»).
 *
 * Живые названия объявлений/кампаний из аудита прод-базы 25.09: у WhatsApp
 * click-to-message переходов часто нет referral-метки, а сама реклама
 * («приемка ...») однозначно зовёт собственников сдать/продать нам объект —
 * и бот из-за этого спрашивал их «вам квартира или вакансия?».
 */
describe("classifyAdTopic — тип рекламы по имени/кампании/группе объявления", () => {
  it('«Публикация в Instagram: 🇹🇯 ВАКАНСИЯ «Менеджери...»» → job', () => {
    expect(classifyAdTopic({ name: "Публикация в Instagram: 🇹🇯 ВАКАНСИЯ «Менеджери...»" })).toBe("job");
  });

  it('«приемка дилафруз  Объявление» → seller', () => {
    expect(classifyAdTopic({ name: "приемка дилафруз  Объявление" })).toBe("seller");
  });

  it('«приемка тадж Кампания» → seller (по campaignName)', () => {
    expect(classifyAdTopic({ name: "Объявление", campaignName: "приемка тадж Кампания" })).toBe("seller");
  });

  it('«приемка русс Объявление» → seller', () => {
    expect(classifyAdTopic({ name: "приемка русс Объявление" })).toBe("seller");
  });

  it('«Публикация в Instagram: Мехоҳед амволи худро...» → seller', () => {
    expect(classifyAdTopic({ name: "Публикация в Instagram: Мехоҳед амволи худро..." })).toBe("seller");
  });

  it('«Фурӯши амвол — ин танҳо ҷойгир кардани эълон нест.» → seller', () => {
    expect(
      classifyAdTopic({ name: 'Публикация: "Фурӯши амвол — ин танҳо ҷойгир кардани эълон нест."' })
    ).toBe("seller");
  });

  it('«Публикация в Instagram: 3-хонага дар Сино №1042» → property', () => {
    expect(classifyAdTopic({ name: "Публикация в Instagram: 3-хонага дар Сино №1042" })).toBe("property");
  });

  it("job старше seller: реклама вакансии менеджера по продажам — не приёмка объекта", () => {
    expect(classifyAdTopic({ name: "ВАКАНСИЯ: Менеджер по продажам недвижимости" })).toBe("job");
  });

  it("isSellerAdRef — прямой предикат тем же правилом", () => {
    expect(isSellerAdRef("приемка дилафруз")).toBe(true);
    expect(isSellerAdRef("собственник, продайте нам объект")).toBe(true);
    expect(isSellerAdRef("z_55 Сино 3 комнаты")).toBe(false);
    expect(isSellerAdRef(null)).toBe(false);
  });
});
