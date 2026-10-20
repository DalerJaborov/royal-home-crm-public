import type { Page, ConsoleMessage } from "@playwright/test";

/**
 * Разделы CRM: путь, узнаваемый заголовок и право, без которого раздел закрыт.
 * Один источник правды для всех smoke-проверок — новый раздел добавляется сюда,
 * и он автоматически попадает во все тесты.
 */
export const SECTIONS = [
  // Все четыре приветствия: без «Доброй ночи» смоук падал у любого, кто запустил
  // его после 23:00, — и выглядело это как поломка дашборда.
  //
  // «Салом» — заголовок ТЕЛЕФОННОЙ главной (components/mobile/MobileHomeHeader.tsx):
  // у половины экранов свой мобильный компонент со своими надписями, и ждать от них
  // десктопных заголовков нельзя. Здесь и ниже перечислены оба варианта — иначе
  // мобильный проект падает на исправном приложении (так и было: /, /messages и
  // /profile падали каждым прогоном).
  // Главная 10.09.2026: заголовка раздела «Пульт директора» больше НЕТ — решение
  // владельца, в артефакте «Единый пульт директора» его нет вовсе, экран начинается
  // сразу с карточки. Единственный заголовок главной — приветствие внутри карточки:
  // «Здравствуйте, {имя}. Вот что в компании сейчас.» (дословно из артефакта).
  // «Салом, {имя}. Сначала это:» — приветствие ролевых главных из того же артефакта.
  // «Сводка, {имя}» — заголовок мобильной главной РУКОВОДИТЕЛЯ из третьего
  // артефакта владельца (перенос 11.09, components/pult/DirectorHome.tsx).
  // Без него мобильный проход падал на исправном приложении: e2e входит
  // директором, а в перечне были только приветствия агента и старой главной.
  // Остальные варианты оставлены для ролей и раскладок, где заголовком служит время суток.
  { path: "/", heading: /Сегодня в Royal Home|Здравствуйте|Салом|Сводка|Добрый день|Доброе утро|Добрый вечер|Доброй ночи|Главная/ },
  { path: "/properties", heading: /Объекты/ },
  { path: "/properties/map", heading: /Карта объектов/ },
  { path: "/clients", heading: /Клиенты|Покупатели/ },
  { path: "/sellers", heading: /Клиенты|Продавцы/ },
  { path: "/deals", heading: /Сделки/ },
  { path: "/calendar", heading: /Календарь/ },
  // Тема 2026 (09.09.2026): заголовок раздела — «Чаты» (Messages.tsx, `<h1>Чаты</h1>`).
  { path: "/messages", heading: /Чаты|Сообщения|Мои чаты|Все чаты/ },
  { path: "/other-inquiries", heading: /Прочие обращения|Клиенты/ },
  { path: "/reports", heading: /Отчёты/ },
  { path: "/sources", heading: /Источники лидов/ },
  { path: "/team", heading: /Команда|Доска почёта/ },
  // «Ключи» удалены полностью (владелец 07.09.2026) — раздел, маршрут, право.
  { path: "/finance", heading: /Финансы|Деньги/ },
  // Расходы рекламных кабинетов по объектам (20.08.2026). Раздел закрыт правом
  // «Финансы» — учётка сида его имеет, как и на /finance выше.
  { path: "/ads", heading: /Реклама/ },
  { path: "/archive", heading: /Архив/ },
  { path: "/site-changes", heading: /Изменения на сайте/ },
  { path: "/profile", heading: /Мой профиль|Профиль и настройки|^Профиль$/ },
] as const;

/** Текст, который рисует ErrorBoundary. Его появление = экран упал. */
export const CRASH_TEXT = "Что-то пошло не так";

/**
 * Собирает ошибки консоли и упавшие запросы за время жизни страницы.
 *
 * Отфильтровываем шум, который не является поломкой приложения: 401/403 на
 * страницах, где право проверяется сервером, и предупреждения браузера про
 * расширения. Всё остальное — повод уронить тест.
 *
 * `ignore` — для случаев, когда стенд сам создал ошибку своими условиями (пример:
 * operator-call.spec.ts глушит service worker, и приложение честно жалуется, что
 * тот не зарегистрирован). Список задаётся ТЕМ тестом, который создал условие, и
 * не действует на остальные: общий фильтр от таких послаблений слепнет.
 */
export function collectPageErrors(page: Page, ignore: RegExp[] = []): { errors: string[] } {
  const errors: string[] = [];

  const isNoise = (text: string, msg?: ConsoleMessage) =>
    ignore.some((pattern) => pattern.test(text)) ||
    // 401/403 — сервер честно закрывает раздел без права, это не поломка экрана.
    /Failed to load resource: the server responded with a status of 40[13]/i.test(text) ||
    // 429 — сработал лимитер запросов: все воркеры Playwright бьют с одного IP,
    // и это защита API работает как задумано, а не дефект приложения.
    /Failed to load resource: the server responded with a status of 429/i.test(text) ||
    // 428 — requireElevation (apps/api/src/lib/stepUp.ts) честно просит подтвердить
    // личность перед чувствительным действием (2FA, ключи доступа, смена настроек).
    // Единственный источник этого кода в API — сам step-up, и фронт везде ловит его
    // через ApiError.status === 428 и поднимает StepUpDialog (см. TwoFactorSettings,
    // FreezeAgentModal) — это не необработанная ошибка, а ожидаемый
    // первый ответ на клик по защищённой кнопке.
    /Failed to load resource: the server responded with a status of 428/i.test(text) ||
    // 400 на /ads/sync — честный ответ «рекламный кабинет не подключён» (нет
    // ключей Meta Ads в Настройках), не поломка кнопки «Сверить с кабинетом».
    // dead-controls.spec.ts нажимает её на любом стенде, в т.ч. без ключей.
    (/Failed to load resource: the server responded with a status of 400/i.test(text) &&
      /\/ads\/sync(\?|$)/.test(msg?.location()?.url ?? "")) ||
    // 428 на /me/2fa — step-up («подтвердите личность»,
    // requireElevation в lib/stepUp.ts). Кнопка «Включить» в TwoFactorSettings.tsx
    // бьёт в /2fa/setup сразу по клику, сессия e2e-логина элевацию не даёт (её
    // выдаёт только отдельный парольный экран, а не обычный вход) — фронт честно
    // ловит 428 и открывает StepUpDialog, это не поломка. Как и 401/403 выше,
    // считаем только сам этот эндпоинт, а не любой 428 на странице.
    (/Failed to load resource: the server responded with a status of 428/i.test(text) &&
      /\/me\/2fa/.test(msg?.location()?.url ?? "")) ||
    /net::ERR_ABORTED/i.test(text) ||
    /Download the React DevTools/i.test(text) ||
    // Хаптика (lib/haptics.ts) пробует navigator.vibrate ещё до первого клика
    // пользователя — Chrome сам блокирует такой вызов и пишет предупреждение в
    // консоль. Экран при этом отрисован полностью и работает; это браузер
    // соблюдает свою политику жестов, а не поломка приложения.
    /Blocked call to navigator\.vibrate because user hasn't tapped/i.test(text);

  /**
   * Чужой сервер — не наша поломка.
   *
   * В сидовых объектах фотографии ссылаются на loremflickr.com. Страница каталога
   * грузит полтора десятка картинок разом, тот упирается в свой лимит и отвечает
   * 500 — и весь прогон краснеет из-за чужого сервиса. 01.08.2026 это стоило часа
   * поисков несуществующей поломки.
   *
   * Смысл теста — «НАШ экран не падает», поэтому считаем только запросы к нашему
   * же адресу. Ошибка загрузки картинки со стороннего домена к этому отношения
   * не имеет: у живого клиента фотографии лежат в нашей папке.
   */
  /**
   * То же самое, но когда чужой адрес назван в ТЕКСТЕ ошибки, а не в её месте.
   *
   * Карта объектов ловит отказ загрузки тайла сама и печатает его своим
   * `console.error` — для браузера это обычное сообщение из нашего кода, поэтому
   * `isForeign` по `msg.location()` его не видит и прогон краснеет из-за
   * недоступного tile.openstreetmap.org. 19.09.2026 это дало ложное падение
   * проверки кнопок в сессии без выхода наружу.
   *
   * Условие нарочно узкое: только сообщения, где прямо сказано о неудачной
   * СЕТЕВОЙ загрузке, и только если названный в них адрес чужой. Любая другая
   * ошибка нашего кода по-прежнему красит прогон.
   */
  const namesForeignFetchFailure = (text: string) => {
    if (!/(Failed to fetch|AJAXError|NetworkError|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET))/i.test(text)) return false;
    const found = text.match(/https?:\/\/[^\s"')]+/);
    if (!found) return false;
    try {
      return new URL(found[0]).origin !== new URL(page.url()).origin;
    } catch {
      return false;
    }
  };

  const isForeign = (msg: ConsoleMessage) => {
    const url = msg.location()?.url ?? "";
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return false;
    // Адрес страницы читаем В МОМЕНТ СОБЫТИЯ: на вызове collectPageErrors страница
    // ещё about:blank, и origin оттуда был бы бессмысленным.
    try {
      const own = new URL(page.url()).origin;
      return new URL(url).origin !== own;
    } catch {
      return false;
    }
  };

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!isNoise(text, msg) && !isForeign(msg) && !namesForeignFetchFailure(text)) errors.push(`console: ${text}`);
  });

  page.on("pageerror", (err: Error) => {
    errors.push(`pageerror: ${err.message}`);
  });

  return { errors };
}

/** Файл сохранённой сессии — свой на каждый проект (десктоп/мобильный). */
export function authFileFor(project: string): string {
  return `playwright/.auth/${project}.json`;
}
