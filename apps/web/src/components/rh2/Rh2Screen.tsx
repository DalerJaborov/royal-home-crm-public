import type { ReactNode } from "react";
import { useShellClaim } from "../../store/shell";

/**
 * Обёртка экрана темы «Royal Home 2026»: `.rh2` включает эталонный CSS
 * (`theme-2026-proto.css`), `.scr` даёт колонку прототипа — предел 1240 px по
 * ширине и вертикальные промежутки между блоками (`.scr>*+*`).
 *
 * Отступы `.scr` обнулены НАРОЧНО: рамка приложения (`layouts/AppLayout`) уже
 * держит свои `px-4 md:px-6 pt-4 pb-24` вокруг `<Outlet />`, и без обнуления
 * поля складывались бы вдвое — на 390 px это съедало 32 px по каждому краю.
 * Правится здесь, а не в CSS: `theme-2026-proto.css` собирается скриптом
 * `scripts/sync-proto-css.py` и руками не редактируется.
 *
 * ЗАГОЛОВОК В ШАПКЕ ОБОЛОЧКИ (контракт 06.10.2026). Три пропса отдают заголовок
 * шапке телефона через `store/shell.ts`, вместо того чтобы шапка угадывала его
 * по разметке:
 *   · `title`   — имя экрана, 22 px в шапке на < 820 px;
 *   · `back`    — путь раздела, куда ведёт «Назад» (не `history.back()`);
 *   · `actions` — до двух круглых кнопок справа (`Button variant="icon"`).
 * На компьютере шапка заголовка не несёт: он стоит на странице в `.pg-h`.
 * Экран без `title` ничего не заявляет — оболочка берёт имя раздела из реестра.
 */
export interface Rh2ScreenProps {
  children: ReactNode;
  title?: string;
  back?: string;
  onBack?: () => void;
  actions?: ReactNode;
  className?: string;
}

export function Rh2Screen({ children, title, back, onBack, actions, className }: Rh2ScreenProps) {
  // Только если экран хоть что-то сообщил: иначе заявка пустая, а пустая заявка
  // затёрла бы чужую (вложенный Rh2Screen внутри экрана с title).
  const claims = title !== undefined || back !== undefined || actions !== undefined;
  return (
    <div className={className ? `rh2 screens ${className}` : "rh2 screens"}>
      {claims && <ShellClaim title={title} back={back} onBack={onBack} actions={actions} />}
      <div className="scr" style={{ padding: 0 }}>
        {children}
      </div>
    </div>
  );
}

/** Отдельным компонентом, чтобы хук вызывался условно по факту наличия пропсов. */
function ShellClaim({ title, back, onBack, actions }: { title?: string; back?: string; onBack?: () => void; actions?: ReactNode }) {
  useShellClaim({ title, back, onBack, actions });
  return null;
}
