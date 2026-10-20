import { ShellOwnHeader } from "../../rh2/ShellOwnHeader";
import { useEffect, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Search, type LucideIcon } from "lucide-react";
import { useNow } from "../../../hooks/useNow";
// Поиск подгружается по нажатию: палитра не должна лежать во входном куске
// сборки, который телефон читает до первой отрисовки.
import { CommandPaletteLazy } from "../../CommandPaletteLazy";
import { useNotifications } from "../../../hooks/useNotifications";
import { todayLabel } from "../../../lib/format";

/**
 * ОБОЛОЧКА МОБИЛЬНОЙ ГЛАВНОЙ — второй артефакт владельца, дословно.
 *
 * Источник: `docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html`, экран
 * `<section class="scr" data-scr="home">`: строка `.top` с приветствием
 * «Салом, {Имя}», датой и двумя круглыми кнопками (поиск, уведомления), под
 * ней прокручиваемое тело `.body` с секциями. Стили приехали отдельным файлом
 * `theme-2026-mobile-home.css` (генерируется scripts/sync-mobile-css.py).
 *
 * ПОЧЕМУ ОБЛАСТЬ ИЗ ДВУХ ЭЛЕМЕНТОВ. Стили мобильного артефакта ограничены
 * `.rh2 .mh`, а не `.rh2.mh`: оба артефакта владельца называют разные вещи
 * одинаково (`.row`, `.card`, `.chip`, `.btn`, `.top`, `.sec`, `.tile`), и
 * пересекаться им нельзя. Потомковый селектор требует ДВУХ разных предков —
 * `<div class="rh2 mh">` на одном элементе не сработал бы вовсе, и это молча:
 * разметка верная, классы верные, экран голый. Ровно та же ловушка описана у
 * `.scr` в scripts/sync-proto-css.py и в components/rh2/Rh2Scope.tsx.
 *
 * ЧЕГО ЗДЕСЬ НЕТ ИЗ ПРЕЖНЕЙ ШАПКИ (components/mobile/MobileHomeHeader.tsx,
 * она остаётся у ролей «Маркетинг» и «Служба безопасности»): широкой пилюли
 * поиска отдельной строкой, кнопки «Звонки» и переключателя темы. В артефакте
 * их нет — там ровно две круглые кнопки. Ничего не потеряно: «Звонки» —
 * раздел нижней панели и меню «Ещё», тема — Профиль → Оформление, поиск здесь
 * же кружком (та же палитра, тот же Ctrl+K).
 */

/**
 * Область во всю ширину экрана, без внешней белой коробки (владелец 11.09:
 * «главные на телефоне в белой коробке с рамкой поверх фона» — отвергнуто).
 *
 * Оболочка приложения даёт содержимому поля `px-5 pt-4` и запас снизу под
 * нижнюю панель (AppLayout.tsx). Артефакт держит свои поля сам — 16 px внутри
 * `.body` и 12/16 px в шапке, — поэтому внешние поля здесь гасятся
 * отрицательным отступом, а запас снизу возвращается уже внутрь области:
 * так мягкий фон `--page` доходит до краёв экрана, а содержимое по-прежнему
 * не заезжает под панель вкладок. Инлайн-стилем, а не новым классом:
 * theme-2026-proto.css собирается скриптом, а своих имён классов тема не
 * заводит (договор дизайна §3) — тот же приём, что у Rh2Scope.tsx.
 */
const MH_HOST: CSSProperties = {
  // Верхнее поле оболочки НЕ гасится намеренно: выше в том же контейнере
  // стоят подсказки (вопрос собственнику, просьба о звонке, уведомления,
  // AppLayout.tsx), и отрицательный отступ сверху наехал бы на их нижний
  // край — молча, ровно на те 16 px, которые он снимает.
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  // Колонка, чтобы `.mh` растянулась на всю высоту области: иначе на коротком
  // экране ниже содержимого проступал бы фон обёртки, а он другого оттенка
  // (`--page` пульта #eef1f6 против #f4f6f9 мобильного артефакта) — тонкая
  // полоса чужого серого внизу читается как «недорисовано».
  display: "flex",
  flexDirection: "column",
};

export function MhScreen({ greeting, children }: { greeting: string; children: ReactNode }) {
  const navigate = useNavigate();
  const [showSearch, setShowSearch] = useState(false);
  const { data: notifications } = useNotifications();
  const unread = notifications?.unreadCount ?? 0;

  return (
    <div className="rh2" style={MH_HOST}>
      <div className="mh">
        <ShellOwnHeader />
        <div className="top">
          <div className="grow">
            <h1 className="greet">{greeting}</h1>
            <p className="date">{todayLabel()}</p>
          </div>
          <button
            type="button"
            className="ico card"
            aria-label="Поиск клиентов, объектов и разделов"
            onClick={() => setShowSearch(true)}
          >
            <Search className="i" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ico card"
            aria-label={unread > 0 ? `Уведомления, непрочитанных ${unread}` : "Уведомления"}
            onClick={() => navigate("/notifications")}
          >
            <Bell className="i" aria-hidden="true" />
            {unread > 0 && <span className="dot" aria-hidden="true" />}
          </button>
        </div>
        <div className="body">{children}</div>
      </div>
      {showSearch && <CommandPaletteLazy onClose={() => setShowSearch(false)} />}
    </div>
  );
}

/** Секция главной: `.sec` + `.sec-t` (заголовок и правая подпись) из артефакта. */
export function MhSection({
  title,
  note,
  first = false,
  children,
}: {
  title: string;
  note?: ReactNode;
  /** Первая секция под шапкой: в артефакте у неё `margin-top:6px`, а не 22. */
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="sec" style={first ? { marginTop: 6 } : undefined}>
      <div className="sec-t">
        <h2>{title}</h2>
        {note != null && <span className="cnt">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** Один пункт ряда быстрых кнопок под шапкой — см. `MhQuickRow` ниже. */
export interface MhQuickAction {
  label: string;
  icon: ComponentType<{ className?: string }>;
  to: string;
  /** Счётчик рядом с подписью — только если страница реально получила число
   *  с сервера. Выдумывать нельзя (CLAUDE.md, «честные данные»), поэтому у
   *  вызывающей стороны нет способа передать сюда что-то, кроме уже
   *  загруженных данных. */
  count?: number;
}

/**
 * Ряд быстрых кнопок под шапкой главной — четыре плитки-перехода в другие
 * разделы. Класс `.qa` уже существует и используется в карточках клиента/
 * объекта/сотрудника/канала (`ClientDetail`, `PropertyDetail`,
 * `TeamMemberDetail.tsx`, `ChannelDetail.tsx`) — тот же ряд быстрых действий,
 * здесь просто ведёт на разделы, а не на формы. Новых классов не заводит:
 * `.quick`/`.plate`-плитки с цветными тонами и счётчиком в углу, которые
 * называет задание, ни в артефакте `artifact-c99db05f-mobile-nav-14-09.html`,
 * ни в `theme-2026-mobile-home.css` не существуют (там `.quick` — это чипы
 * быстрых ответов в переписке, другой экран); `.qa` — единственный реально
 * существующий и уже стилизованный ряд кнопок для этой цели.
 */
export function MhQuickRow({ actions }: { actions: MhQuickAction[] }) {
  const navigate = useNavigate();
  if (actions.length === 0) return null;
  return (
    <div className="qa" role="group" aria-label="Быстрые действия" style={{ marginTop: 6 }}>
      {actions.map((a) => (
        <button key={a.to} type="button" onClick={() => navigate(a.to)}>
          <a.icon className="i" aria-hidden="true" />
          {a.count != null ? `${a.label} · ${a.count}` : a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Тихая строка «Нет данных: …» и её родственницы.
 *
 * Правило проекта: выдумывать числа нельзя, отсутствие данных говорится прямо
 * (CLAUDE.md, «честные данные»). В артефакте для этого есть готовый вид —
 * блок `.quiet` с цветной точкой: зелёная «всё в порядке», жёлтая «стоит
 * посмотреть», красная «горит».
 */
export function MhQuiet({ tone, children }: { tone?: "ok" | "warn" | "crit"; children: ReactNode }) {
  const dot = tone === "warn" ? "w" : tone === "crit" ? "c" : undefined;
  return (
    <div className="quiet">
      <div className="ln">
        <i className={dot} aria-hidden="true" />
        <span>{children}</span>
      </div>
    </div>
  );
}

/** Тон плитки быстрой кнопки — четыре тона макета по кругу, `QUICK_TONE` в `quickRow()`. */
export type MhQuickTone = "aqua" | "lav" | "lime" | "sky";

export interface MhQuickItem {
  key: string;
  icon: LucideIcon;
  label: string;
  href: string;
  tone: MhQuickTone;
  /** Счётчик в углу плитки — только настоящее число из уже загруженных данных.
   *  Нет числа — нет плитки-пилюли (правило «честные данные», CLAUDE.md), не 0. */
  count?: number;
}

/**
 * Ряд быстрых кнопок под шапкой — `quickRow(role)` артефакта c99db05f (правки
 * 14.09.2026 вечером): `.quick` → четыре `.q` (плитка `.plate` + подпись).
 * Состав своей четвёрки — забота вызывающего экрана, этот компонент только
 * рисует то, что ему передали, и прячет то, на что у роли нет права (пункт
 * приходит `null`/не попадает в массив ДО вызова — сама плитка прав не знает).
 */
export function MhQuick({ items }: { items: MhQuickItem[] }) {
  const navigate = useNavigate();
  if (items.length === 0) return null;
  return (
    <section className="sec" style={{ marginTop: 6 }}>
      <div className="quick">
        {items.map((it) => (
          <button type="button" className="q" key={it.key} onClick={() => navigate(it.href)}>
            <span className="wr">
              <span className={`plate ${it.tone}`} aria-hidden="true">
                <it.icon className="i" aria-hidden={true} />
              </span>
              {typeof it.count === "number" && it.count > 0 && <span className="cnt2">{it.count}</span>}
            </span>
            <b>{it.label}</b>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Та же тихая строка, но как самостоятельная карточка секции. */
export function MhNoData({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" | "crit" }) {
  return (
    <div className="card-s">
      <MhQuiet tone={tone}>{children}</MhQuiet>
    </div>
  );
}

/**
 * Карточка «Деньги» артефакта: крупная сумма, подпись и полоса плана.
 *
 * Полоса заполняется анимацией ширины (в артефакте её ставит скрипт после
 * первого кадра, `requestAnimationFrame`, — иначе перехода не видно). Тот же
 * приём здесь: ширина 0 на первом кадре, настоящая — на следующем.
 */
export function MhMoney({ amount, sub, percent }: { amount: string; sub: string; percent: number | null }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="card-s big money">
      <div className="big">{amount}</div>
      <div className="sub">{sub}</div>
      {percent !== null && (
        <div className="bar">
          <i style={{ width: grown ? `${Math.max(0, Math.min(100, percent))}%` : 0 }} />
        </div>
      )}
    </div>
  );
}

/**
 * Общее «сейчас» для таймеров ожидания. Один интервал на экран, а не по
 * таймеру на строку: строк бывает два десятка, и двадцать интервалов будят
 * телефон двадцать раз в секунду.
 */
export function useSecondTick(enabled: boolean): number {
  return useNow(enabled);
}

/** «12:40» — сколько осталось; одна реализация на все главные (lib/countdown.ts). */
export { mmss } from "../../../lib/countdown";
