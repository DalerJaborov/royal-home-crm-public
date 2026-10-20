import fs from "node:fs";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";
import { WIZARD_STEPS, stepIndexOf, type WizardStepKey } from "../../src/components/property-wizard/types";

/**
 * ШАГ «ГДЕ» МАСТЕРА ДОБАВЛЕНИЯ ОБЪЕКТА (/properties/new, components/property-wizard).
 *
 * Карта, геопозиция и обратный геокодер не проверялись e2e вовсе — smoke и
 * dead-controls открывают шаг и видят, что он отрисовался, но не разрешение
 * геопозиции, не точность, не офлайн, не то, что ручной адрес не затирается
 * автоподсказкой при сдвиге карты. Плюс «прогресс фото сразу» и черновик на
 * сервере (11.09.2026) — тоже новые механизмы этого мастера без покрытия.
 *
 * Все тесты идут под ролью AGENT (не требует «кто принял объект» на шаге
 * «Продавец» — упрощает прохождение мастера целиком).
 *
 * ПОСЛЕДОВАТЕЛЬНО, А НЕ ПАРАЛЛЕЛЬНО (test.describe.configure ниже). Черновик
 * мастера живёт на сервере ОДИН на агента (PUT/DELETE /properties/drafts/current,
 * PropertyWizard.tsx), а не per-браузер: два теста этого файла, запущенных
 * параллельно (fullyParallel: true в конфиге), наперегонки писали бы и удаляли
 * один и тот же черновик и путали бы предложение «продолжить?» друг у друга.
 */
test.describe.configure({ mode: "serial" });

/** Координаты внутри Душанбе — конкретное место не важно, важна повторяемость. */
const DUSHANBE_POINT = { latitude: 38.5598, longitude: 68.787 };

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * ОДИН контекст под ролью AGENT на весь файл, вкладка — своя на каждый тест.
 *
 * Не «свой контекст на тест»: у входа свой лимитер (20 попыток на 15 минут НА
 * НОМЕР, и он уже срабатывал), а каждый новый контекст — это ещё одна проверка
 * сохранённого состояния и потенциально ещё один вход. Файл и так идёт
 * последовательно, делить состояние между тестами здесь нечему: черновик живёт
 * на сервере (его чистит `afterEach`), в localStorage мастер ничего не держит.
 * Разрешение геопозиции между тестами снимается `clearPermissions` — иначе
 * тест «геопозиция запрещена» получил бы разрешение от предыдущего.
 */
let shared: BrowserContext | null = null;
let activePage: Page | null = null;

/** Тот же путь, что и внутри `contextForRole` (roleAuth.ts, `stateFile`). */
const AGENT_STATE_FILE = "playwright/.auth/role-agent.json";

/**
 * Жива ли сохранённая сессия — спрашиваем API, а не страницу.
 *
 * Собственная проверка `contextForRole` смотрит на адрес после `goto("/")`, а
 * увод на /login происходит ПОЗЖЕ: приложение сначала загружается, потом идёт
 * обновлять токен по refresh-cookie и только на отказе уходит на вход. Отозванная
 * сессия (MAX_DEVICES=3 в lib/sessions.ts вытесняет самую старую) эту проверку
 * поэтому проходит, и тест падает на первом же ожидании заголовка — так и вышло:
 * вместо мастера открылась форма входа. Здесь ответ однозначный и без гонки.
 */
async function sessionAlive(context: BrowserContext): Promise<boolean> {
  const res = await context.request.post("/api/v1/auth/refresh").catch(() => null);
  return !!res && res.ok();
}

async function agentContext(browser: Browser): Promise<BrowserContext> {
  if (shared) return shared;
  let context = await contextForRole(browser, "AGENT");
  if (!(await sessionAlive(context))) {
    // Кэш протух — убираем файл, чтобы `contextForRole` вошёл заново (вход
    // ровно один на прогон файла, лимитеру это не мешает).
    await context.close();
    fs.rmSync(AGENT_STATE_FILE, { force: true });
    context = await contextForRole(browser, "AGENT");
  }
  shared = context;
  return context;
}

async function agentPage(browser: Browser): Promise<Page> {
  const context = await agentContext(browser);
  const page = await context.newPage();
  activePage = page;
  return page;
}

/**
 * Клик «Начать заново» ждёт не только исчезновения баннера (он гаснет
 * СИНХРОННО, `setOffered(null)` стоит до `await` в `declineOffer`), а
 * настоящего ответа DELETE /drafts/current. Без этого гонка реальна: баннер
 * уже скрыт, тест идёт дальше и запускает СВОЁ автосохранение, а прошлый
 * DELETE долетает до сервера позже и стирает свежесохранённые значения —
 * поймано этим же файлом на шаге восстановления черновика (тест ниже).
 */
async function clickDraftRestart(page: Page): Promise<void> {
  // «Начать заново» СПРАШИВАЕТ ПОДТВЕРЖДЕНИЕ (PropertyWizard.tsx::DraftGate).
  // Кнопка в подвале только открывает ConfirmDialog — черновик удаляет уже
  // кнопка в диалоге. Проверка про это не знала и ждала, что предложение
  // исчезнет от первого клика: экран оставался на заслонке черновика, а
  // падало потом и в другом месте («нет wizard-next»), что уводило разбор в
  // сторону. Подписи у обеих кнопок одинаковые — вторую берём внутри диалога.
  await page.getByTestId("wizard-draft-restart").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const deleted = page
    .waitForResponse(
      (res) => res.url().includes("/api/v1/properties/drafts/current") && res.request().method() === "DELETE",
      { timeout: 5_000 }
    )
    .catch(() => undefined);
  await dialog.getByRole("button", { name: "Начать заново" }).click();
  await deleted;
}

/**
 * Черновик чистим КНОПКОЙ ИНТЕРФЕЙСА («Начать заново»), а не запросом
 * DELETE через `page.request`, хотя он и проще: `requireAuth` на сервере
 * (apps/api/src/auth/middleware.ts) принимает только заголовок
 * `Authorization: Bearer <accessToken>`, а сам токен нигде не персистится —
 * он живёт исключительно в памяти вкладки (zustand-стор без него в
 * `partialize`, apps/web/src/store/auth.ts) и недоступен ни в cookie, ни в
 * localStorage, которые `page.request` мог бы унаследовать от контекста.
 * Поэтому чистим тем же путём, что и настоящий агент: заходим в мастер и
 * жмём «Начать заново», если черновик предложен.
 */
async function cleanupDraft(page: Page): Promise<void> {
  await page.goto("/properties/new").catch(() => undefined);
  const offer = page.getByTestId("wizard-draft-offer");
  await settledWizard(page).catch(() => undefined);
  if (await offer.isVisible().catch(() => false)) {
    await clickDraftRestart(page).catch(() => undefined);
  }
}

/**
 * Дождаться, пока мастер решил, что показывать: заслонку черновика или шаги.
 * До ответа сервера о черновике на экране ТОЛЬКО тихая строка ожидания
 * (PropertyWizard.tsx, `draftChecked`) — ни шкалы шагов, ни заслонки. Раньше
 * шаги рисовались сразу и заслонка падала поверх уже заполняемой формы; это
 * починено, и проверка теперь ждёт исход, а не одну из двух его половин.
 */
async function settledWizard(page: Page): Promise<void> {
  await expect(page.getByTestId("wizard-draft-offer").or(page.getByRole("progressbar")).first()).toBeVisible({
    timeout: 15_000,
  });
}

test.afterEach(async () => {
  const page = activePage;
  activePage = null;
  if (!page) return;
  const context = page.context();
  await context.setOffline(false).catch(() => undefined);
  await cleanupDraft(page);
  await page.close().catch(() => undefined);
  // Разрешения снимаем ПОСЛЕ уборки черновика: она ходит на сервер, а не в
  // геопозицию, но следующий тест начинается с чистого листа именно здесь.
  await context.clearPermissions().catch(() => undefined);
});

test.afterAll(async () => {
  await shared?.close().catch(() => undefined);
  shared = null;
});

/** Разрешить геопозицию и задать координаты — делать ДО первого захода на шаг
 *  «Где»: карта запрашивает позицию один раз при монтировании. */
async function grantGeo(page: Page, accuracy: number): Promise<void> {
  const context = page.context();
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ ...DUSHANBE_POINT, accuracy });
}

/** Открыть мастер с чистого листа — снимает черновик прошлого прогона, если
 *  сервер его предложит, иначе шаги ниже пошли бы вразнобой со старыми данными. */
async function gotoWizard(page: Page): Promise<void> {
  await page.goto("/properties/new");
  // Сначала — исход проверки черновика (см. settledWizard): на заслонке шкалы
  // шагов нет вовсе, поэтому ждать сразу её значило бы падать на исправном
  // мастере с незаконченным черновиком.
  await settledWizard(page);
  const offer = page.getByTestId("wizard-draft-offer");
  if (await offer.isVisible().catch(() => false)) {
    await clickDraftRestart(page);
    await expect(offer).toBeHidden({ timeout: 5_000 });
  }
  // Признак открытого мастера — его шкала шагов, а не заголовок «Новый объект»:
  // такого заголовка на экране нет с переезда мастера на пошаговую оболочку
  // (components/property-wizard/WizardShell.tsx), а название шага меняется от
  // шага к шагу. Шкала есть всегда и подписана «Шаг N из M».
  await expect(page.getByRole("progressbar")).toBeVisible({ timeout: 15_000 });
}

/**
 * Поле шага «Главное»/«Продавец» по НАДПИСИ. Не `getByLabel`: у части полей
 * (например, «Окон») рядом с подписью в том же `<label>` лежит ещё и текст
 * подсказки (`.msg`), и он попадает в доступное имя элемента — подстрочный
 * поиск тогда путает «Этаж» с «Этажей в доме». Здесь сравнивается ТОЛЬКО текст
 * `.lab`, точным совпадением.
 */
function labeledInput(page: Page, label: string) {
  const exact = new RegExp(`^${escapeRegExp(label)}$`);
  // Две разметки поля, и обе живые (19.09.2026). Прежняя — `label.fld` с
  // подписью в `.lab`; на шаге «Главное» после переодевания в облик артефакта
  // (15.09.2026) поле рисуется как `div.f > label > input`. Проверка знала
  // только первую и падала на исправном мастере: поле с подписью «Площадь, м²»
  // на экране есть, а локатор его не видит.
  return page
    .locator("label.fld, div.f")
    .filter({ has: page.locator(".lab, label").filter({ hasText: exact }) })
    .locator("input");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ШАГ НАЗЫВАЕТСЯ КЛЮЧОМ, А НЕ НОМЕРОМ (22.09.2026).
 *
 * Номера были вписаны в проверку буквально, и перестановка «Продавца» на
 * первое место (#642) молча развернула весь файл: после первого «Далее»
 * мастер стоит на «Фото и видео», а проверка заполняет «Главное» и падает
 * «поле Площадь, м² не найдено» — читается как поломка мастера, хотя мастер
 * исправен. Поэтому и номер шага, и их общее число берутся из самого кода
 * (WIZARD_STEPS): переставить шаги и не заметить проверку больше нельзя.
 */
function stepHeading(page: Page, key: WizardStepKey) {
  // Строка шага теперь несёт ещё и подсказку через точку («Шаг 4 из 5 · Имя и
  // телефон собственника», WizardShell.tsx), поэтому совпадение по НАЧАЛУ, а
  // не по всей строке: точное `$` перестало сходиться после переодевания
  // мастера, и проверка падала на исправном экране (19.09.2026).
  const n = stepIndexOf(key) + 1;
  return expect(
    page.getByText(new RegExp(`^Шаг ${n} из ${WIZARD_STEPS.length}`)).first()
  ).toBeVisible({ timeout: 10_000 });
}

/** Минимум для прохождения шага «Главное» (propertyCreateSchema через validateStep). */
async function fillMainStep(page: Page): Promise<void> {
  await labeledInput(page, "Площадь, м²").fill("64.5");
  await labeledInput(page, "Комнат").fill("3");
  await labeledInput(page, "Этаж").fill("5");
  await labeledInput(page, "Этажей в доме").fill("9");
  await labeledInput(page, "Окон").fill("6");
  await labeledInput(page, "Цена").fill("850000");
}

async function fillSellerStep(page: Page): Promise<void> {
  // Подписи полей — «Имя» и «Телефон» (StepSeller.tsx), а не «Имя продавца»:
  // слово «продавец» ушло в заголовок шага при переодевании мастера, и
  // проверка искала подпись, которой нет (19.09.2026).
  await labeledInput(page, "Имя").fill("Тестовый Продавец");
  await labeledInput(page, "Телефон").fill("+992900111222");
}

async function selectFirstDistrict(page: Page): Promise<void> {
  const tabs = page.getByRole("tablist", { name: "Район" }).getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
  await tabs.first().click();
}

/**
 * Заполнить обязательное на шаге `key` — ровно столько, чтобы `validateStep`
 * пропустил дальше. Шаги без обязательных полей («Фото и видео», «Проверка»)
 * здесь ничего не делают, и это не пропуск: у них нечего заполнять.
 */
async function fillStep(page: Page, key: WizardStepKey): Promise<void> {
  if (key === "main") return fillMainStep(page);
  if (key === "seller") return fillSellerStep(page);
  if (key === "place") {
    await selectFirstDistrict(page);
    await page.getByTestId("wizard-address-input").fill("Тестовая улица, 1");
  }
}

/**
 * Дойти от первого шага мастера до `target`, заполняя обязательное по пути.
 * Порядок шагов не вписан сюда — он берётся из WIZARD_STEPS (см. stepHeading).
 */
async function advanceTo(page: Page, target: WizardStepKey): Promise<void> {
  const last = stepIndexOf(target);
  for (let i = 0; i < last; i += 1) {
    await stepHeading(page, WIZARD_STEPS[i].key);
    await fillStep(page, WIZARD_STEPS[i].key);
    await page.getByTestId("wizard-next").click();
  }
  await stepHeading(page, target);
}

/** Номер текущего шага по шкале («Шаг N из M», WizardShell.tsx). */
async function currentStepIndex(page: Page): Promise<number> {
  const text = (await page.getByText(/^Шаг \d+ из \d+/).first().innerText()) ?? "";
  const m = /^Шаг (\d+) из/.exec(text.trim());
  if (!m) throw new Error(`не удалось прочитать номер шага из «${text}»`);
  return Number(m[1]) - 1;
}

/**
 * Встать на шаг `key`, откуда бы мастер ни открылся. Нужно после
 * «Продолжить»: восстановленный черновик открывается на СВОЁМ сохранённом
 * шаге (PropertyWizard.tsx::applyOffer), а какой шаг успело записать
 * автосохранение — вопрос момента, и привязывать к нему проверку значений
 * значит ловить ложные падения. Ходим только назад-вперёд по уже пройденному:
 * поля везде заполнены, validateStep пропустит.
 */
async function ensureStep(page: Page, key: WizardStepKey): Promise<void> {
  const target = stepIndexOf(key);
  for (let guard = 0; guard < WIZARD_STEPS.length * 2; guard += 1) {
    const at = await currentStepIndex(page);
    if (at === target) return;
    await page.getByTestId(at > target ? "wizard-back" : "wizard-next").click();
    await stepHeading(page, WIZARD_STEPS[at > target ? at - 1 : at + 1].key);
  }
  throw new Error(`не удалось дойти до шага «${key}»`);
}

/** Дойти от начала мастера до готовой карты на шаге «Где», заполнив
 *  обязательное по пути. */
async function toPlaceStep(page: Page): Promise<void> {
  await gotoWizard(page);
  await advanceTo(page, "place");
  await expect(page.getByTestId("wizard-map")).toHaveAttribute("data-map-ready", "true", { timeout: 20_000 });
}

/** Центр карты в экранных координатах — жест таскания метится сюда: метка
 *  «как в такси» всегда в центре контейнера (MapPointPicker.tsx). */
async function mapCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("wizard-map").boundingBox();
  if (!box) throw new Error("карта не отрисовалась — boundingBox пуст");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragMap(page: Page, dx: number, dy: number): Promise<void> {
  const { x, y } = await mapCenter(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

/**
 * Геопозиция запрашивается ТОЛЬКО по тапу (17.09.2026, MapPointPicker.tsx):
 * раньше открытие шага само спрашивало разрешение и молча ставило точку там,
 * где стоит агент. Поэтому все три проверки ниже сначала нажимают «Определить
 * мою позицию», а уже потом смотрят на статус. До 19.09.2026 они ждали статуса
 * сразу после открытия шага и падали на исправном мастере.
 */
async function requestGeo(page: Page): Promise<void> {
  await page.getByTestId("wizard-geo-retry").click();
}

test(`геопозиция разрешена: метка встаёт на свою точку @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  await grantGeo(page, 20);
  await toPlaceStep(page);
  await requestGeo(page);
  await expect(page.getByTestId("wizard-geo-status")).toContainText("Метка на вашей точке", { timeout: 15_000 });
});

test(`геопозиция запрещена: статус честный, кнопка повтора доступна @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  // Отказ подделываем явно (19.09.2026). Прежде полагались на то, что контекст
  // без grantPermissions сам ответит отказом; на деле headless не отвечает
  // ВООБЩЕ — обращение висит, статус остаётся «Определяю, где вы стоите…», и
  // проверка падала не на поведении приложения, а на молчании браузера.
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_success, error) =>
      error?.({
        code: 1,
        message: "User denied Geolocation",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
  });
  await toPlaceStep(page);
  await requestGeo(page);
  const status = page.getByTestId("wizard-geo-status");
  await expect(status).toContainText(/запрещ/i, { timeout: 15_000 });
  const retry = page.getByTestId("wizard-geo-retry");
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
});

test(`плохая точность геопозиции показана метрами @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  await grantGeo(page, 300);
  await toPlaceStep(page);
  await requestGeo(page);
  await expect(page.getByTestId("wizard-geo-status")).toContainText(/точностью около\s*300\s*м/i, {
    timeout: 15_000,
  });
});

test(`поле адреса остаётся редактируемым без сети @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  // Геопозиция нужна не ради неё самой: ниже она — единственный способ дать
  // шагу НОВУЮ точку уже в офлайне одинаково на обеих ширинах (см. комментарий
  // у второй части теста).
  await grantGeo(page, 20);
  await toPlaceStep(page);

  // context.setOffline, а не блокировка доменов Nominatim/OSM через
  // context.route: одним переключателем роняются И тайлы карты (Leaflet сам
  // отловит tileerror → wizard-map-offline), И navigator.onLine/событие
  // offline, на которое подписан useReverseGeocode (StepPlace покажет статус
  // «нет сети»). route.abort() пришлось бы наводить на оба домена отдельно и
  // держать в синхронизации со списком, который дергает код карты.
  await page.context().setOffline(true);

  // ГЛАВНОЕ ЭТОГО ТЕСТА: без сети адрес и район остаются рабочими руками.
  // Проверяется безусловно, потому что это и есть требование владельца — «карта
  // не грузится, поле адреса остаётся рабочим».
  const addressInput = page.getByTestId("wizard-address-input");
  await addressInput.fill("Улица Рудаки, 12");
  await expect(addressInput).toHaveValue("Улица Рудаки, 12");
  await selectFirstDistrict(page);
  await expect(page.getByRole("tablist", { name: "Район" }).getByRole("tab").first()).toHaveAttribute(
    "aria-selected",
    "true"
  );

  /**
   * ВТОРАЯ ЧАСТЬ: мастер обязан СКАЗАТЬ, что сети нет, а не молчать.
   *
   * Заставляем шаг получить НОВУЮ точку уже в офлайне — иначе обратный геокодер
   * не запускается вовсе (его эффект зависит от координат) и честно молчит,
   * а тест ловил бы не поведение приложения, а собственное бездействие.
   * Сдвиг карты пальцем для этого не годится: в проекте mobile жесты мыши в
   * перетаскивание карты не превращаются, и на мобильной ширине тест падал
   * именно поэтому. Берём путь, одинаковый на обеих ширинах: сдвигаем
   * ЭМУЛИРОВАННУЮ геопозицию и просим определить её заново кнопкой.
   */
  await page.context().setGeolocation({
    latitude: DUSHANBE_POINT.latitude + 0.004,
    longitude: DUSHANBE_POINT.longitude + 0.004,
  });
  await page.getByTestId("wizard-geo-retry").click();

  const offlineBanner = page.getByTestId("wizard-map-offline");
  const addressStatus = page.getByTestId("wizard-address-status");
  await expect
    .poll(
      async () => {
        if (await offlineBanner.isVisible().catch(() => false)) return true;
        return /нет сети|не определить/i.test((await addressStatus.textContent()) ?? "");
      },
      {
        timeout: 15_000,
        message: "ни офлайн-баннер карты, ни статус адреса не сообщили об отсутствии сети",
      }
    )
    .toBe(true);

  // Ручной адрес пережил всё это и не затёрт подсказкой.
  await expect(addressInput).toHaveValue("Улица Рудаки, 12");

  await page.context().setOffline(false);
});

/**
 * Обратное геокодирование отвечает НАШИМ ответом, а не живым Nominatim
 * (19.09.2026).
 *
 * Проверка смотрит, переживает ли РУЧНОЙ адрес автоподстановку, а не работает
 * ли сейчас openstreetmap.org. На живом сервисе она зависела от чужой сети и
 * чужих лимитов: там, где наружу нет выхода, поле оставалось пустым и проверка
 * падала на исправном мастере; на прогоне с выходом в сеть тот же сервис
 * отвечает то 200, то 429 своей же политикой «не долбить».
 */
async function stubReverseGeocode(page: Page): Promise<void> {
  await page.route("https://nominatim.openstreetmap.org/reverse**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        address: { road: "Улица из геокодера", house_number: "1", city_district: "Исмоили Сомони" },
        display_name: "Улица из геокодера, 1, Душанбе",
      }),
    })
  );
}

test(`ручной адрес не затирается автоподсказкой при сдвиге карты @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  await grantGeo(page, 20);
  await stubReverseGeocode(page);
  await toPlaceStep(page);

  const addressInput = page.getByTestId("wizard-address-input");
  // Подсказку надо СПРОВОЦИРОВАТЬ движением карты: при открытии шага адрес
  // больше не подставляется сам — геопозицию мастер не запрашивает без тапа
  // (17.09.2026), а без неё и геокодировать нечего. Раньше проверка ждала
  // подстановки сразу после открытия и падала на исправном мастере.
  await dragMap(page, 40, 20);
  await expect(addressInput).not.toHaveValue("", { timeout: 15_000 });

  const manualAddress = "Свой адрес, дом 99";
  await addressInput.fill(manualAddress);
  await expect(addressInput).toHaveValue(manualAddress);

  await dragMap(page, 60, 0);
  await page.waitForTimeout(2_000);

  await expect(addressInput).toHaveValue(manualAddress);
});

/**
 * ОРИЕНТИР СТАВИТСЯ САМ (владелец 25.09.2026): как только есть точка, поле
 * «Ориентир» под адресом заполняется одним-двумя местами рядом, а вписанное
 * агентом больше не трогается. Ответ сервера подменён: проверяется поведение
 * поля, а не справочник ориентиров (его проверяет landmark-suggest.test.ts).
 */
test(`ориентир ставится сам по точке и не затирает правку агента @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  let calls = 0;
  await page.route("**/api/v1/geo/landmarks?**", (route) => {
    calls += 1;
    const text = calls === 1 ? "рядом ТЦ Садбарг, 400 м от ЦУМа" : `рядом Мехргон ${calls}`;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text, landmarks: [] }) });
  });
  await toPlaceStep(page);

  const landmark = page.getByTestId("wizard-landmark-input");
  await dragMap(page, 40, 20);
  await expect(landmark).toHaveValue("рядом ТЦ Садбарг, 400 м от ЦУМа", { timeout: 15_000 });
  await expect(page.getByTestId("wizard-landmark-auto")).toBeVisible();

  // Сдвиг точки обновляет подставленное самим сайтом.
  await dragMap(page, 60, 0);
  await expect(landmark).toHaveValue(/^рядом Мехргон \d+$/, { timeout: 15_000 });

  // Вписанное агентом остаётся, куда бы ни двигалась точка.
  await landmark.fill("за Овиром");
  await dragMap(page, -50, 30);
  await expect.poll(() => calls, { timeout: 15_000 }).toBeGreaterThan(2);
  await page.waitForTimeout(500);
  await expect(landmark).toHaveValue("за Овиром");
  await expect(page.getByTestId("wizard-landmark-auto")).toHaveCount(0);
});

test(`возврат на шаг «Где» не сбрасывает точку и адрес @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  await toPlaceStep(page);

  await dragMap(page, 50, -30);
  await selectFirstDistrict(page);
  const addressInput = page.getByTestId("wizard-address-input");
  await addressInput.fill("Проверка возврата, 5");
  const addressBefore = await addressInput.inputValue();

  // Шаг ПОСЛЕ «Где» берём из WIZARD_STEPS: важно уйти с шага и вернуться, а
  // не то, как соседний шаг называется сегодня.
  await page.getByTestId("wizard-next").click();
  await stepHeading(page, WIZARD_STEPS[stepIndexOf("place") + 1].key);
  await page.getByTestId("wizard-back").click();
  await stepHeading(page, "place");

  await expect(page.getByTestId("wizard-map")).toHaveAttribute("data-map-ready", "true", { timeout: 15_000 });
  await expect(addressInput).toHaveValue(addressBefore);
});

test(`несовпадение района предлагает переключиться, а не переключает само @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  await grantGeo(page, 20);
  await toPlaceStep(page);

  const tabs = page.getByRole("tablist", { name: "Район" }).getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
  const count = await tabs.count();
  if (count < 2) {
    test.skip(true, "В справочнике меньше двух районов — переключать не на что");
  }

  // «Первый в ленте, если выбран не он» — если первый уже выбран (подсказка
  // геокодера могла указать именно на него), берём заведомо другой, второй.
  const firstAlreadySelected = (await tabs.nth(0).getAttribute("aria-selected")) === "true";
  await tabs.nth(firstAlreadySelected ? 1 : 0).click();

  const mismatch = page.getByTestId("wizard-district-mismatch");
  const appeared = await mismatch.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!appeared) {
    test.skip(true, "Геокодер не подтвердил точку районом — предупреждение о несовпадении не появилось");
  }

  const switchBtn = page.getByTestId("wizard-district-switch");
  const switchLabel = (await switchBtn.getAttribute("aria-label")) ?? "";
  const targetName = switchLabel.replace("Переключить район на ", "").trim();
  expect(targetName.length, `не удалось прочитать название района из «${switchLabel}»`).toBeGreaterThan(0);

  await switchBtn.click();
  await expect(mismatch).toBeHidden({ timeout: 5_000 });
  await expect(
    page.getByRole("tablist", { name: "Район" }).getByRole("tab", { name: targetName, exact: true })
  ).toHaveAttribute("aria-selected", "true");
});

test(`кнопки навигации мастера живые, включая отмену и закрытие @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);

  // Отмена доступна только на первом шаге (WizardShell.tsx: onBack === null) и
  // должна увести из мастера, а не просто «ничего не делать».
  await gotoWizard(page);
  await page.getByTestId("wizard-cancel").click();
  await expect(page).toHaveURL(/\/properties(\?|$)/);

  // Свежий заход — сквозной проход по ВСЕМ шагам с проверкой счётчика, и на
  // каждой границе ещё шаг назад и снова вперёд: «Назад» ломался незаметно
  // чаще, чем «Далее». Порядок и число шагов — из WIZARD_STEPS, руками здесь
  // не перечисляются (см. stepHeading).
  await gotoWizard(page);
  await stepHeading(page, WIZARD_STEPS[0].key);

  for (let i = 0; i < WIZARD_STEPS.length - 1; i += 1) {
    const from = WIZARD_STEPS[i].key;
    const to = WIZARD_STEPS[i + 1].key;
    await fillStep(page, from);
    await page.getByTestId("wizard-next").click();
    await stepHeading(page, to);
    await page.getByTestId("wizard-back").click();
    await stepHeading(page, from);
    await page.getByTestId("wizard-next").click();
    await stepHeading(page, to);
  }

  // На шаге проверки «Далее» превращается в «Сохранить» и создаёт объект —
  // не нажимаем; закрытие проверяем отдельной, безопасной кнопкой.
  await page.getByTestId("wizard-close").click();
  await expect(page).toHaveURL(/\/properties(\?|$)/);
});

test(`прогресс фото виден сразу, снимок можно убрать @wizard-map`, async ({ browser }) => {
  const page = await agentPage(browser);
  await gotoWizard(page);
  await advanceTo(page, "media"); // «Фото и видео» больше не первый шаг (WIZARD_STEPS)

  await page.getByTestId("wizard-photo-input").setInputFiles({
    name: "test-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  });

  const tile = page.getByTestId("wizard-photo-tile").first();
  await expect(tile).toBeVisible({ timeout: 1_000 });
  await expect(tile).toHaveAttribute("data-upload-status", "ready", { timeout: 20_000 });

  await page.getByTestId("wizard-photo-remove").first().click();
  await expect(page.getByTestId("wizard-photo-tile")).toHaveCount(0);
});

test(`черновик восстанавливается после перезагрузки страницы @wizard-map`, async ({ browser }, testInfo) => {
  /**
   * ТОЛЬКО ОДИН ПРОЕКТ, И ЭТО НЕ ПРОБЕЛ В ПРОВЕРКЕ ТЕЛЕФОНА (22.09.2026).
   *
   * Черновик на сервере ОДИН НА АГЕНТА, а оба проекта (ПК и телефон) входят
   * одной и той же учётной записью. Файлы идут параллельно, и соседний проект
   * успевает удалить черновик между нашим PUT и перезагрузкой: тест падал
   * ОБОИМИ проектами разом, хотя каждый по отдельности зелёный. Ждать
   * появления предложения — единственное место в файле, которому чужой
   * черновик мешает; остальные тесты к нему терпимы и идут на обоих проектах.
   *
   * Разводить проекты по разным учёткам — правильнее, но это правка сида и
   * входа для всего набора; здесь она не к месту. Восстановление черновика
   * при этом не зависит от ширины экрана: мастер один и тот же компонент
   * (`PropertyWizard.tsx`, отдельного `Mobile*` у него нет).
   */
  test.skip(
    testInfo.project.name !== "chromium",
    "черновик на сервере один на агента — два проекта разом стирают его друг у друга"
  );
  const page = await agentPage(browser);
  await gotoWizard(page);
  await advanceTo(page, "main");

  // Ждём именно ответ автосохранения (PUT /drafts/current), а не
  // фиксированную паузу: AUTOSAVE_DELAY_MS = 2,5 с (PropertyWizard.tsx)
  // отсчитывается от ПОСЛЕДНЕГО изменения поля, и шесть полей fillMainStep
  // сами по себе занимают заметную долю времени — засекать 2,5 с от начала
  // заполнения было нестабильно (поймано первым прогоном: 6 с не хватило).
  // Ждём не ЛЮБОЙ PUT, а тот, что несёт заполненное здесь: шаг «Продавец»
  // теперь идёт перед «Главным» (WIZARD_STEPS), и его собственное
  // автосохранение успевает уехать первым — на него проверка снималась бы с
  // ожидания раньше, чем на сервер попало «Главное», и падала бы после
  // перезагрузки на пустом поле «Площадь».
  const autosave = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/properties/drafts/current") &&
      res.request().method() === "PUT" &&
      (res.request().postData() ?? "").includes("64.5"),
    { timeout: 20_000 }
  );
  await fillMainStep(page);
  await autosave;

  await page.reload();
  const offer = page.getByTestId("wizard-draft-offer");
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("wizard-draft-continue").click();
  await ensureStep(page, "main");

  await expect(labeledInput(page, "Площадь, м²")).toHaveValue("64.5");
  await expect(labeledInput(page, "Комнат")).toHaveValue("3");
  await expect(labeledInput(page, "Цена")).toHaveValue("850000");

  // Не оставляем черновик следующим тестам файла: черновик один на агента на
  // сервере, восстанавливаем начисто в свежей загрузке.
  await page.reload();
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await clickDraftRestart(page);
});
