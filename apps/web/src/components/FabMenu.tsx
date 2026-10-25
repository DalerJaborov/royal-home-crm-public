import { useEffect, useState } from "react";
import {
  Home,
  UserPlus,
  CalendarPlus,
  ClipboardList,
  BarChart3,
  Wallet,
  Compass,
  ShieldAlert,
  PhoneCall,
  Route as RouteIcon,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import type { PermissionId } from "@royal-home/shared";
import { hapticTap } from "../lib/haptics";
import { RH2_ROW_BUTTON, Rh2Portal } from "./rh2/Rh2Scope";
import { ShowingQuickForm } from "./ShowingQuickForm";
import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";

/**
 * Всплывающее меню кнопки «+» нижней навигации — по прототипу design_handoff
 * (`Royal Home CRM - Мобайл.dc.html`, блок `sheetActs`/`SETS`): нажатие на «+»
 * не ведёт сразу на форму объекта, а открывает шторку с 4 пунктами, набор
 * которых зависит от роли (там же `SETS.boss/agent/marketing/security/operator`).
 *
 * Раньше кнопка «+» в BottomNav.tsx всегда делала `navigate("/properties/new")`
 * — самое частое действие агента, но для директора/админа (роль в прототипе
 * называется `boss`) владелец прислал скриншот именно с меню из четырёх пунктов
 * («Новый объект», «Поставить задачу», «Отчёт за неделю», «Добавить расход»).
 *
 * ЧЕСТНОСТЬ МАРШРУТОВ. Каждый пункт ведёт на реально существующий раздел CRM.
 * Там, где в прототипе подразумевается отдельная форма создания (например
 * «Записать показ» — в CRM показ заводится только из карточки клиента,
 * AddInteractionModal, отдельного маршрута нет), пункт открывает раздел
 * целиком, а не выдуманную форму. Голосовой ввод удержанием кнопки
 * («Удержите кнопку — заполню голосом» в прототипе) — реализован не здесь:
 * распознавание речи в CRM уже есть в AssistantPanel.tsx (useSpeechRecognition,
 * тот же ИИ-ассистент, что за кнопкой-звёздочкой), удержание кнопки «+» в
 * BottomNav.tsx открывает именно его с сразу включённым микрофоном — вместо
 * того чтобы строить вторую, урезанную реализацию распознавания здесь.
 */

interface FabMenuItem {
  label: string;
  sub: string;
  icon: LucideIcon;
  /** t/f — фон и цвет иконки, взяты из прототипа (t1..t4/f1..f4: см. SETS). */
  tint: string;
  fg: string;
  /** Маршрут, куда ведёт пункт. */
  to?: string;
  /** Либо действие прямо в меню: форма показа открывается, не уводя с экрана. */
  action?: "showing";
}

/** Цвета пунктов — точные hex из прототипа (t1..t4 / f1..f4 в `qa(...)`).
 * f1/t1 — тот самый фиолетовый, который дизайн-хендофф ошибочно принимали за
 * акцент всей CRM (см. предупреждение в CLAUDE.md); здесь это НЕ акцентная
 * кнопка, а один из четырёх цветов вторичных бейджей меню — используем как
 * есть, инлайн-стилем, потому что готового Tailwind-токена под этот конкретный
 * оттенок в repo нет (см. royalhome-tailwind-token-gotchas). */
const TINTS = {
  violet: { bg: "#eee9ff", fg: "#7b61ff" },
  pink: { bg: "#fbe9f1", fg: "#b45285" },
  blueInfo: { bg: "#e3f2ff", fg: "#3b82c4" },
  green: { bg: "#e5f6ee", fg: "#2f9068" },
};

function buildItems(role: string | undefined, can: (p: PermissionId) => boolean): FabMenuItem[] {
  const objectNew: FabMenuItem = {
    label: "Новый объект",
    sub: "форма в 4 шага",
    icon: Home,
    tint: TINTS.green.bg,
    fg: TINTS.green.fg,
    to: "/properties/new",
  };
  const clientNew: FabMenuItem = {
    label: "Новый клиент",
    sub: "форма и проверка дублей",
    icon: UserPlus,
    tint: TINTS.violet.bg,
    fg: TINTS.violet.fg,
    to: "/clients?new=1",
  };
  const showNew: FabMenuItem = {
    label: "Записать показ",
    sub: "выбрать клиента и назначить",
    icon: CalendarPlus,
    tint: TINTS.blueInfo.bg,
    fg: TINTS.blueInfo.fg,
    action: "showing",
  };
  const taskNew: FabMenuItem = {
    label: "Поставить задачу",
    sub: "агенту офиса",
    icon: ClipboardList,
    tint: TINTS.violet.bg,
    fg: TINTS.violet.fg,
    to: "/oversight",
  };
  const reportWeek: FabMenuItem = {
    label: "Отчёт за неделю",
    sub: "комиссия и воронка",
    icon: BarChart3,
    tint: TINTS.blueInfo.bg,
    fg: TINTS.blueInfo.fg,
    to: "/reports",
  };
  const expenseNew: FabMenuItem = {
    label: "Добавить расход",
    sub: "в финансы месяца",
    icon: Wallet,
    tint: TINTS.pink.bg,
    fg: TINTS.pink.fg,
    to: "/finance",
  };
  const sources: FabMenuItem = {
    label: "Источники лидов",
    sub: "откуда пришли",
    icon: Compass,
    tint: TINTS.blueInfo.bg,
    fg: TINTS.blueInfo.fg,
    to: "/sources",
  };
  const checkNew: FabMenuItem = {
    label: "Открыть проверку",
    sub: "по клиенту или сделке",
    icon: ShieldAlert,
    tint: TINTS.blueInfo.bg,
    fg: TINTS.blueInfo.fg,
    to: "/security",
  };
  const callsList: FabMenuItem = {
    label: "Записи звонков",
    sub: "прослушать разговор",
    icon: PhoneCall,
    tint: TINTS.green.bg,
    fg: TINTS.green.fg,
    to: "/calls",
  };
  const acceptCall: FabMenuItem = {
    label: "Принять звонок",
    sub: "станция и очередь",
    icon: PhoneCall,
    tint: TINTS.green.bg,
    fg: TINTS.green.fg,
    to: "/telephony",
  };
  const routeInquiry: FabMenuItem = {
    label: "Распределить обращение",
    sub: "по агентам",
    icon: RouteIcon,
    tint: TINTS.violet.bg,
    fg: TINTS.violet.fg,
    to: "/other-inquiries",
  };

  // Директор/админ (в прототипе — `boss`): ровно набор со скриншота владельца.
  if (role === "DIRECTOR" || role === "ADMIN") {
    return [
      objectNew,
      can("dashboard.analytics") ? taskNew : null,
      can("reports.view") ? reportWeek : null,
      can("finance.view") ? expenseNew : null,
    ].filter((i): i is FabMenuItem => i !== null);
  }
  if (role === "MARKETING" || role === "EDITOR") {
    return [objectNew, sources, clientNew].filter(Boolean) as FabMenuItem[];
  }
  if (role === "SECURITY") {
    return [can("clients.securityReview") ? checkNew : null, callsList].filter(Boolean) as FabMenuItem[];
  }
  if (role === "MANAGER") {
    return [acceptCall, routeInquiry, clientNew, showNew];
  }
  // Агент по умолчанию — самое частое действие первым.
  return [objectNew, clientNew, showNew];
}

export function FabMenu({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const role = useAuthStore((s) => s.agent?.role);
  const can = useCan();
  const legacyAgentMobile = useLegacyAgentMobile();
  const items = buildItems(role, can).map((item) => legacyAgentMobile && item.action === "showing"
    ? { ...item, action: undefined, to: "/calendar", sub: "выбрать клиента в календаре" }
    : item);
  // «Записать показ» открывает форму поверх меню, а не уводит на другой экран:
  // пока она открыта, меню остаётся смонтированным (его закрытие снимало бы форму).
  const [showingOpen, setShowingOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  if (showingOpen) return <ShowingQuickForm onClose={onClose} />;

  // Шторка снизу эталона (`.sheet.bottom` + `.grab`), портал в body с областью
  // темы: без `Rh2Portal` ни одно правило эталона до меню не дошло бы
  // (см. Rh2Scope.tsx). `data-no-sheet` снимает окно с общего правила index.css,
  // которое иначе наложило бы на шторку вторую раскладку и вторую ручку.
  return (
    <Rh2Portal>
      <div className="sheet-back" onClick={onClose} />
      <div className="sheet bottom" role="menu" aria-label="Быстрые действия" data-no-sheet>
        <div className="grab" aria-hidden />
        <div className="sheet-b">
          <div className="list">
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                className="row"
                style={RH2_ROW_BUTTON}
                onClick={() => {
                  hapticTap();
                  if (item.action === "showing") {
                    setShowingOpen(true);
                    return;
                  }
                  onClose();
                  if (item.to) navigate(item.to);
                }}
              >
                {/* Тон значка — из прототипа (SETS t1..t4/f1..f4), инлайн-стилем:
                    готового имени класса под этот конкретный оттенок в теме нет. */}
                <span className="call" style={{ background: item.tint, color: item.fg, borderColor: "transparent" }}>
                  <item.icon className="i lg" />
                </span>
                <div className="t">
                  <b>{item.label}</b>
                  <span>{item.sub}</span>
                </div>
              </button>
            ))}
          </div>
          {/* Видимая подсказка про голос (ревью телефона 06.10.2026): удержание «+»
              открывает ассистента с включённым микрофоном, но жест, который нигде
              не подписан, новичок не находит. Строка тихая, не кнопка. */}
          {!legacyAgentMobile && <div className="quiet" data-fab-voice-hint>
            <div className="ln">
              <span>Удержите «+», чтобы сказать голосом</span>
            </div>
          </div>}
          {/* Раздела «Спросить ИИ» здесь больше нет (14.09.2026, владелец: «других
              входов в ассистента на телефоне быть не должно» — оставлен ровно один,
              удержание кнопки «+» 450 мс, BottomNav.tsx → AssistantPanel.tsx). Второй
              вход (тап по этому пункту) открывал тот же ассистент в один клик и был
              лишним: два способа попасть в одно и то же место расходятся при первой
              же правке одного из них и путают, где «настоящая» точка входа. */}
        </div>
      </div>
    </Rh2Portal>
  );
}
