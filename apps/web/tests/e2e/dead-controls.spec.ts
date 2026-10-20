import { test, expect, type Page } from "@playwright/test";
import { SECTIONS, CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * МЁРТВЫЕ ЭЛЕМЕНТЫ УПРАВЛЕНИЯ: кнопка на экране есть, а нажатие ничего не делает.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ (владелец 27.08.2026: «почему так много багов я нахожу
 * самостоятельно, а вы нет»). Три из четырёх находок того дня объединяет одно:
 * ни `tsc`, ни серверные тесты, ни smoke-прогон не могли их увидеть в принципе.
 *
 *   • Кнопки «Закрыть напоминание» не существовало ДЕВЯТЬ ДНЕЙ: серверный
 *     маршрут и хук были написаны 18.08, а на экран их не вывели. Агенты гасили
 *     навязчивое окно единственным доступным способом — «Отложить на 10 минут»,
 *     четыре раза, дальше оно висело безвыходно.
 *   • «Заморозить сотрудника» — то же самое: маршрут с правами, отпуском и
 *     освобождением лидов написан, интерфейс показывает метку «заморожен» в пяти
 *     местах, а поставить её нельзя ниоткуда.
 *
 * Smoke отвечает на вопрос «экран открылся?». Этот файл — на следующий:
 * «а работает ли то, что на экране нарисовано?».
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАРОЧНО: проверки бизнес-смысла действий. Она в серверных
 * тестах. Здесь — только доходимость: элемент виден, доступен, нажимаем и
 * получаем реакцию, а не тишину.
 */

/** Кнопки, которые НЕ должны ничего делать до заполнения формы или выбора. */
const EXPECTED_INERT = /Сохранить|Записать|Отправить|Создать|Добавить|Удалить|Применить/i;

/**
 * Кнопки, открывающие системный диалог выбора файла (тот же случай, что WIZARD_SKIP
 * ниже для /properties/new, — 22.09.2026). «Фото профиля»/«Изменить фото» на /profile
 * (Profile.tsx) — тоже просто `fileRef.current?.click()`: ни сети, ни перехода, ни
 * изменения разметки клик не даёт, и clickIsAlive честно, но неверно считает кнопку
 * мёртвой. Диалог выбора файла без обработки завис бы прогон — как и в мастере.
 */
const AVATAR_SKIP = /Фото профиля|Изменить фото/i;

/**
 * Кнопка считается живой, если нажатие вызвало хоть что-то: сетевой запрос,
 * переход, прокрутку к нужному месту, открытие окна или изменение самой
 * страницы. Тишина в ответ на клик — и есть мёртвая кнопка.
 */

/**
 * Снимок прокрутки — окна и всех прокрученных элементов (19.09.2026).
 *
 * Плитки сводки на /reports и /finance не ведут никуда: они прокручивают
 * страницу к своему разделу ниже (`scrollToSection`, решение владельца от
 * 15.09.2026 — «плитки должны вести куда-нибудь»). Ни адрес, ни длина разметки,
 * ни сеть при этом не меняются, и проверка объявляла исправные плитки мёртвыми
 * — на телефоне, где прокрутка внутри контейнера, а не окна.
 */
async function scrollSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    let signature = String(window.scrollY);
    for (const element of document.querySelectorAll("*")) {
      if (element.scrollTop || element.scrollLeft) signature += `|${element.scrollTop},${element.scrollLeft}`;
    }
    return signature;
  });
}
async function clickIsAlive(page: Page, button: ReturnType<Page["getByRole"]>): Promise<boolean> {
  const urlBefore = page.url();
  const htmlBefore = await page.evaluate(() => document.body.innerHTML.length);
  // Перед каждым нажатием возвращаем страницу наверх: все четыре плитки сводки
  // на /reports ведут к ОДНОМУ разделу, и после первой страница уже там —
  // остальные трём не к чему прокручивать, и они выглядели бы мёртвыми.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll("*")) {
      if (element.scrollTop) element.scrollTop = 0;
    }
  });
  const scrollBefore = await scrollSignature(page);
  let sawRequest = false;
  const onRequest = () => {
    sawRequest = true;
  };
  // Кнопки вида «Изменить фото» кликают по скрытому `<input type="file">`
  // (`fileRef.current.click()`), а не по видимому полю формы: у него нет ни
  // подписи «Выбрать/Снять/Из галереи» из WIZARD_SKIP ниже (тот список — только
  // для мастера объекта), ни сетевого запроса, ни изменения DOM — реакция вся
  // целиком в Chromium, который Playwright перехватывает событием `filechooser`
  // вместо настоящего системного окна. Без этой проверки кнопка загрузки
  // аватара (Profile.tsx) считалась мёртвой, хотя работает как задумано —
  // диалог выбора файла и есть её реакция на нажатие.
  let sawFileChooser = false;
  const onFileChooser = () => {
    sawFileChooser = true;
  };
  page.on("request", onRequest);
  page.on("filechooser", onFileChooser);
  try {
    await button.click({ timeout: 5_000 });
    // Секунда — столько живёт человеческое ожидание «нажал и ничего»: меньше
    // даёт ложные срабатывания на медленной анимации, больше растягивает прогон.
    await page.waitForTimeout(1_000);
  } catch {
    // Кнопка не кликается (перекрыта, disabled в момент клика) — это не «мертва»,
    // а недоступна: отдельный случай, его ловит проверка видимости ниже.
    return true;
  } finally {
    page.off("request", onRequest);
    page.off("filechooser", onFileChooser);
  }
  const htmlAfter = await page.evaluate(() => document.body.innerHTML.length);
  const scrollAfter = await scrollSignature(page);
  return (
    sawRequest || sawFileChooser || page.url() !== urlBefore || htmlAfter !== htmlBefore || scrollAfter !== scrollBefore
  );
}

for (const section of SECTIONS) {
  test(`на ${section.path} видимые кнопки отвечают на нажатие @controls`, async ({ page }) => {
    const { errors } = collectPageErrors(page);
    await page.goto(section.path);
    await expect(page.getByRole("heading", { name: section.heading }).first()).toBeVisible({ timeout: 15_000 });

    // Берём только явно названные кнопки: у иконок без подписи проверять
    // нечего — они и должны молчать до наведения.
    const buttons = page.getByRole("button").filter({ hasNotText: EXPECTED_INERT }).filter({ hasNotText: AVATAR_SKIP });
    const count = Math.min(await buttons.count(), 6);

    const dead: string[] = [];
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
      const label = ((await button.textContent()) ?? "").trim();
      // Без подписи — не наш случай (иконка-переключатель, крестик закрытия).
      if (label.length < 3) continue;
      // «Кнопка уже здесь» — не мёртвая кнопка (19.09.2026).
      // Логотип в боковом меню ведёт на главную (Sidebar.tsx, aria-label «На
      // главную»). На самой главной ему нечем ответить: адрес тот же, запроса
      // нет, разметка не меняется — и проверка объявляла его мёртвым. Это не
      // поломка интерфейса, а единственный случай, когда молчание правильно.
      const ariaLabel = (await button.getAttribute("aria-label")) ?? "";
      if (section.path === "/" && /На главную/i.test(ariaLabel)) continue;
      // Опасные действия не нажимаем: этот тест ходит и по боевому стенду.
      if (/Удалить|Выйти|Отменить сделку|Завершить/i.test(label)) continue;

      if (!(await clickIsAlive(page, button))) dead.push(label);

      // Нажатие могло увести со страницы — возвращаемся, иначе дальше проверяем
      // совсем другой экран и получаем бессмысленный отчёт.
      if (!page.url().includes(section.path) && section.path !== "/") {
        await page.goto(section.path);
        await expect(page.getByRole("heading", { name: section.heading }).first()).toBeVisible({ timeout: 15_000 });
      }
    }

    await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
    expect(dead, `кнопки без реакции на ${section.path}: ${dead.join(", ")}`).toEqual([]);
    expect(errors, `ошибки на ${section.path}:\n${errors.join("\n")}`).toEqual([]);
  });
}

/**
 * МАСТЕР ДОБАВЛЕНИЯ ОБЪЕКТА (/properties/new) — своим списком исключений, а не
 * общим циклом по SECTIONS: три подписи открывают системный диалог выбора
 * файла («Снять» и «Из галереи» — камера/галерея на шаге «Фото и видео»,
 * «Выбрать видео» — туда же) и клик по ним без обработчика диалога подвесил бы
 * прогон; «Сохранить» на шаге «Проверка» создаёт объект — этого тест делать не
 * должен.
 */
// «Выбрать», а не «Выбрать видео» (19.09.2026): подпись кнопки видео сменилась,
// а список исключений остался прежним — проверка начала жать её и подвисала на
// системном окне выбора файла. Ровно тот случай, ради которого список и заведён.
const WIZARD_SKIP = /Снять|Из галереи|Выбрать|Сохранить/i;

test("на /properties/new видимые кнопки отвечают на нажатие @controls", async ({ page }) => {
  const { errors } = collectPageErrors(page);
  await page.goto("/properties/new");
  // Признак открытого мастера — его шкала шагов, а не заголовок «Новый объект»:
  // такого заголовка на экране нет с тех пор, как мастер переехал на пошаговую
  // оболочку (components/property-wizard/WizardShell.tsx), а название шага
  // меняется от шага к шагу. Шкала есть всегда и подписана «Шаг N из M».
  await expect(page.getByRole("progressbar")).toBeVisible({ timeout: 15_000 });

  const buttons = page.getByRole("button").filter({ hasNotText: EXPECTED_INERT }).filter({ hasNotText: WIZARD_SKIP });
  const count = Math.min(await buttons.count(), 6);

  const dead: string[] = [];
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
    const label = ((await button.textContent()) ?? "").trim();
    if (label.length < 3) continue;

    if (!(await clickIsAlive(page, button))) dead.push(label);

    if (!page.url().includes("/properties/new")) {
      await page.goto("/properties/new");
      await expect(page.getByRole("progressbar")).toBeVisible({ timeout: 15_000 });
    }
  }

  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(dead, `кнопки без реакции на /properties/new: ${dead.join(", ")}`).toEqual([]);
  expect(errors, `ошибки на /properties/new:\n${errors.join("\n")}`).toEqual([]);
});

/**
 * НАВЯЗЧИВОЕ ОКНО: закрыли — и оно не вернулось.
 *
 * Живой случай 27.08.2026, ради которого проверка и заведена: обязательное окно
 * «Как прошёл звонок» приходило снова на каждом опросе очереди, в том числе по
 * карточке, удалённой полчаса назад. Единственной кнопкой было «Отложить на 10
 * минут» с четырьмя попытками, после которых окно висело навсегда.
 */
test("обязательное окно закрывается насовсем @controls", async ({ page }) => {
  await page.goto("/");
  const banner = page.getByRole("region", { name: /Как прошёл звонок|Итог показа|Итог объекта|Итог приёмки/ });

  if ((await banner.count()) === 0) {
    test.skip(true, "Сейчас нет ни одного обязательного окна — проверять нечего");
  }

  const close = banner.first().getByRole("button", { name: /Закрыть/ });
  await expect(close, "у обязательного окна должна быть кнопка закрытия, а не только «Отложить»").toBeVisible();
  await close.click();
  await expect(banner.first()).toBeHidden({ timeout: 10_000 });

  // Очередь опрашивается раз в минуту — ждём заведомо дольше одного опроса.
  await page.waitForTimeout(65_000);
  await expect(banner.first(), "закрытое окно вернулось — оно снова навязчивое").toBeHidden();
});
