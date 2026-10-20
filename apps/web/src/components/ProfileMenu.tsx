import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Settings as SettingsIcon, UserCircle } from "lucide-react";
import { RH2_ROW_BUTTON, Rh2Portal } from "./rh2/Rh2Scope";
import { useAuthStore } from "../store/auth";
import { signOut } from "../lib/signOut";
import { ROLE_LABELS } from "../lib/roles";
import { useCan } from "../lib/permissions";
import { ProfileAvatar } from "./ProfileAvatar";

/**
 * Профиль в правом верхнем углу — единственная точка входа в учётную запись.
 *
 * Раньше их было две: блок внизу сайдбара на десктопе и аватарка в шапке на
 * телефоне. Человек, пересевший с компьютера на телефон, искал выход не там,
 * где привык. Правый верхний угол — то место, где профиль ищут по умолчанию
 * в любом рабочем инструменте, поэтому оставлен он один.
 *
 * ⚠️ 18.08.2026: на телефоне меню раньше дублировало ПОЛНЫЙ список разделов
 * (весь сайдбар минус 4 нижние вкладки) — это было верно ДО появления вкладки
 * «Ещё» (17.08, вечер), а после неё стало вторым, избыточным входом в те же
 * разделы: список разрастался почти во весь экран и перекрывал контент под
 * собой (жалоба владельца «меню странное, всё перекрывает» + «профиль
 * почему-то есть» — второй способ попасть туда же, куда ведёт «Ещё»). Список
 * разделов убран отсюда — он и так есть в «Ещё»; здесь остаётся только сам
 * профиль, «Настройки CRM» и выход, на десктопе и телефоне одинаково.
 */
export function ProfileMenu({
  triggerClassName,
  avatarTextClassName = "text-[13px]",
}: { triggerClassName?: string; avatarTextClassName?: string } = {}) {
  const navigate = useNavigate();
  const agent = useAuthStore((s) => s.agent);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Меню уходит в createPortal (см. комментарий у оверлея ниже), поэтому
  // считаем координаты от самой кнопки один раз при открытии, как в Topbar.tsx.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  // ⚠️ 15.09.2026, вторая волна. Профиль отвязан от реестра меню совсем.
  // Сначала здесь стояло `system.map(...)` — все восемь системных разделов,
  // дубль с «Ещё»; потом «первый пункт по маршруту /settings». И то и другое
  // держало профиль на поводке у группы: любое её пополнение молча пополняло
  // и меню профиля. Профилю нужна ОДНА ссылка, и он знает её сам.
  const can = useCan();

  // Escape закрывает меню: без этого с клавиатуры из него было не выйти.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Возвращаем фокус на кнопку: иначе после закрытия он оставался в никуда,
      // и следующий Tab начинал обход страницы с начала.
      buttonRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // При открытии переводим фокус на первый пункт — иначе с клавиатуры меню
  // открывалось, но управлять им было нечем.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [open]);

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  function handleLogout() {
    // Один общий выход на все четыре точки (lib/signOut): гасит состояние сразу,
    // а push-подписку этого устройства снимает в фоне — иначе уведомления с именем
    // клиента продолжали приходить на телефон, с которого уже вышли.
    void signOut();
    navigate("/login");
  }

  // Пункт меню — строка `.row` эталона (56 px, значок, текст, счётчик справа).
  const item = "row";

  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        onClick={() => {
          if (!open && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
          }
          setOpen((v) => !v);
        }}
        aria-label="Профиль и выход"
        aria-expanded={open}
        aria-haspopup="menu"
        // 44px на телефоне — норма для пальца; на десктопе 36px, чтобы совпадать
        // с рядом иконок в шапке. `triggerClassName` — переопределение размера:
        // мобильная шапка Главной ужимает кружок до 34px в ряд с кнопками
        // прототипа design_handoff (там их три по 34px; зону нажатия возвращает
        // .tap-target), остальные экраны живут на прежних размерах.
        // overflow-hidden живёт на внутреннем span, а не на самой кнопке: на
        // кнопке он обрезал бы собственное :focus-visible кольцо (box-shadow
        // клипуется overflow того же элемента) — с клавиатуры фокус был не
        // виден ни на одном круглом аватаре в шапках.
        className={
          triggerClassName ??
          "grid h-11 w-11 shrink-0 place-items-center rounded-full transition-transform active:scale-90 md:h-9 md:w-9"
        }
      >
        <span className={`grid h-full w-full place-items-center overflow-hidden rounded-full bg-linear-to-br from-avatar-from to-avatar-to font-bold text-on-accent ${avatarTextClassName}`}>
          <ProfileAvatar src={agent?.avatarUrl} fallback={initials(agent?.fullName)} className="h-full w-full object-cover" />
        </span>
      </button>

      {open && menuPos && (
        <Rh2Portal>
          {/* Оверлей и панель — ОБА в document.body, одним поддеревом (как FabMenu.tsx),
              а не оверлей отдельно рядом с панелью в шапке: шапка стоит на матовом
              стекле с backdrop-filter, который создаёт containing block для
              fixed-потомков. Оверлей внутри шапки сжимался до её 56px высотой вместо
              всего экрана — тап ниже шапки проходил насквозь, и меню не закрывалось
              (тот же класс бага, что у колокольчика уведомлений, см. Topbar.tsx,
              30.08.2026). Раз панель тоже в портале, её позиция — не Tailwind-absolute,
              а px от кнопки (menuPos), снятые один раз при открытии.

              Обёртка `Rh2Portal` обязательна: портал уносит меню за пределы области
              темы, и без неё ни `.card`, ни `.row` не нарисовались бы (Rh2Scope.tsx). */}
          <div className="sheet-back" style={{ backdropFilter: "none", background: "transparent" }} onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            role="menu"
            className="card tight"
            style={{
              position: "fixed",
              zIndex: 41,
              top: menuPos.top,
              right: menuPos.right,
              width: 232,
              maxHeight: "calc(100dvh - 5rem)",
              overflowY: "auto",
            }}
          >
            <div className="kvp">
              <b>{agent?.fullName ?? "Гость"}</b>
              <span>{agent ? ROLE_LABELS[agent.role] : "Агент"} · онлайн</span>
            </div>

            <div className="list">
              <button type="button" role="menuitem" onClick={() => go("/profile")} className={item} style={RH2_ROW_BUTTON}>
                <UserCircle className="i" />
                <div className="t">
                  <b>Мой профиль</b>
                </div>
              </button>

              {/* «Настройки CRM» — единственный пункт сверх «Мой профиль»/«Выйти»:
                  сюда заходят из любого места, не только через «Ещё». */}
              {can("settings.view") && (
                <button type="button" role="menuitem" onClick={() => go("/settings")} className={item} style={RH2_ROW_BUTTON}>
                  <SettingsIcon className="i" />
                  <div className="t">
                    <b>Настройки CRM</b>
                  </div>
                </button>
              )}

              <button type="button" role="menuitem" onClick={handleLogout} className={item} style={RH2_ROW_BUTTON}>
                <LogOut className="i" />
                <div className="t">
                  <b>Выйти</b>
                </div>
              </button>
            </div>
          </div>
        </Rh2Portal>
      )}
    </div>
  );
}


export function initials(name?: string) {
  if (!name) return "?";
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
