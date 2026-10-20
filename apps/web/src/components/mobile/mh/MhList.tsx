import { ShellOwnHeader } from "../../rh2/ShellOwnHeader";
import type { CSSProperties, ReactNode } from "react";
import { dushanbeDate, dushanbeDayKey } from "../../../lib/date";

/**
 * ОБЩИЕ ЧАСТИ СПИСОЧНЫХ ЭКРАНОВ ТЕЛЕФОНА — артефакт владельца «телефон после
 * экспертизы» (docs/pult/theme-2026/artifact-de2845f1-phone-after.html):
 * шапка `.top` с компактным заголовком и круглыми кнопками, лента фильтров
 * `.lane`, карточка-список `.list`. Стили — theme-2026-mobile-lists.css.
 *
 * ПОЧЕМУ НЕ MhScreen (components/home/mh/MhScreen.tsx). Та шапка — с главной
 * второго артефакта: крупное приветствие «Салом, Далер», дата под ним, поиск и
 * колокольчик. У списков в третьем артефакте шапка другая: заголовок 20 px со
 * счётчиком и СВОИ действия («+ клиент» на «Клиентах», ничего на «Ещё»).
 * Общее у них — только область `.rh2 > .mh` и её отступы, и именно они здесь
 * повторены; выносить одну шапку на два разных облика значило бы сочинить
 * третий, которого у владельца нет.
 */

/**
 * Область во всю ширину экрана. Значения — те же, что у MH_HOST в
 * components/home/mh/MhScreen.tsx, и по той же причине: оболочка (AppLayout)
 * даёт содержимому поля `px-5 pt-4` и запас снизу под нижнюю панель, а артефакт
 * держит свои поля сам. Копия, а не импорт: файл главной правится параллельно
 * другими задачами, и связывать список с ним ради четырёх строк CSS-значений
 * дороже, чем повторить их (обе копии описывают одно и то же место оболочки,
 * которое меняется только вместе с самой оболочкой).
 */
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

/**
 * Экран-список: шапка с заголовком и действиями, под ней прокручиваемое тело.
 *
 * `count` — число справа от заголовка («Покупатели · 86»). null означает «ещё
 * не знаем» и не рисуется вовсе: нуль на месте незагруженного счётчика — это
 * выдуманное число.
 */
export function MhListScreen({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: number | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rh2" style={MH_HOST}>
      <div className="mh">
        <ShellOwnHeader />
        <div className="top">
          <div className="grow">
            <h1 className="s">
              {title}
              {count != null && <span className="num"> · {count.toLocaleString("ru-RU")}</span>}
            </h1>
          </div>
          {actions}
        </div>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

/** Один чип ленты фильтров: подпись и необязательное число справа от неё. */
export interface MhLaneChip {
  key: string;
  label: string;
  /** Число рядом с подписью. undefined — счётчика у среза нет, и он не рисуется. */
  count?: number | null;
  active?: boolean;
  onSelect: () => void;
}

/**
 * Лента фильтров БЕЗ карточки-обёртки (артефакт: до первой строки 150 px вместо
 * 250–420). Прокручивается вбок, справа маска — видно, что чипы продолжаются.
 */
export function MhLane({
  label,
  chips,
  sticky = false,
}: {
  label: string;
  chips: MhLaneChip[];
  /**
   * Прижать ленту срезов к верху экрана при прокрутке списка.
   *
   * Владелец 21.09.2026 про каталог объектов: «они ещё тянутся вниз-вверх,
   * будто не фикс, исправить положение». Срез — это то, чем человек управляет
   * списком, и уезжать вместе со списком он не должен.
   *
   * Признаком, а не общим правилом: ленту носят все списочные экраны, и на
   * части из них над ней стоит своя шапка или строка поиска — прижатая лента
   * налезла бы на них. Включаем там, где посмотрели глазами.
   */
  sticky?: boolean;
}) {
  return (
    <div className={sticky ? "lane lane-sticky" : "lane"} role="tablist" aria-label={label}>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="f"
          role="tab"
          /* aria-pressed вместе с role="tab" запрещён (axe aria-allowed-attr, critical):
             у вкладки состояние выражает только aria-selected. Поймано прогоном axe
             11.09 на /clients, /sellers, /messages. */
          aria-selected={!!c.active}
          onClick={c.onSelect}
        >
          {c.label}
          {c.count != null && <span className="c">{c.count.toLocaleString("ru-RU")}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Давность в правой колонке строки — «41 мин», «2 ч», «сегодня», «вчера»,
 * «3 дн», «9 сент», ровно как в артефакте.
 *
 * Своя функция, а не `listTime` (lib/format.ts): та отвечает на вопрос «когда»
 * («14:05», «вчера», «10 сент») и годится списку чатов, где важно время
 * последней реплики. У строки клиента в артефакте другой вопрос — «сколько уже
 * молчим», и первые сутки там считаются в минутах и часах. Границы суток — по
 * Душанбе (dushanbeDayKey), а не по часам устройства: контейнер живёт в UTC, и
 * `setHours` здесь дал бы «вчера» посреди рабочего дня.
 */
export function sinceLabel(date: string | Date | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const minutes = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  // Дальше сутками — но «сегодня»/«вчера» словами, как в артефакте.
  const now = new Date();
  const day = dushanbeDayKey(d);
  if (day === dushanbeDayKey(now)) return "сегодня";
  if (day === dushanbeDayKey(new Date(now.getTime() - 86_400_000))) return "вчера";
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} дн`;
  // «9 сент» — без точки, как в правой колонке артефакта.
  return dushanbeDate(d, { day: "numeric", month: "short" }).replace(".", "");
}
