/**
 * ЗНАЧКИ ЭТАЛОНА «ROYAL HOME 2026» — контуры дословно из прототипа.
 *
 * Источник: ветка `docs/pult-theme-07-09`, экраны
 * `docs/pult/theme-2026/screens/calls.html`, `telephony.html`,
 * `call-window-v2.html`. В макете значки нарисованы инлайновым <svg class="i">;
 * здесь ровно те же атрибуты и ровно те же `d`, вынесенные в один модуль, чтобы
 * не копировать одну и ту же кривую в четыре файла. Ни один путь не «поправлен»:
 * lucide-иконки приложения сюда не подмешиваются — у них другая сетка и другая
 * толщина линии, и на фоне эталонных они читаются как чужие.
 *
 * Класс `i` (и `i lg`, `i xl`) задаёт размер и обводку — см. `_components.css`.
 */
import type { SVGProps } from "react";

type IconProps = { className?: string } & Omit<SVGProps<SVGSVGElement>, "className">;

/** Общая обвязка: те же атрибуты, что у `<svg class="i">` в макете. */
function Icon({ className = "i", children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Трубка — общая основа входящей/исходящей/пропущенной стрелки. */
const HANDSET = "M5 3h4l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2.2 2A17 17 0 0 1 3 5.2 2 2 0 0 1 5 3Z";

export function IconIncoming(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 4 14 10M20 4h-5M20 4v5" />
      <path d={HANDSET} />
    </Icon>
  );
}

export function IconOutgoing(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14 10 6-6M15 4h5v5" />
      <path d={HANDSET} />
    </Icon>
  );
}

export function IconMissed(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m2 5 20 14" />
      <path d={HANDSET} />
    </Icon>
  );
}

/** Просто трубка: пустое состояние журнала и подсказки. */
export function IconPhone(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={HANDSET} />
    </Icon>
  );
}

/** Клавиатура набора — кнопка «Набрать номер» в шапке обоих экранов. */
export function IconKeypad(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <circle cx="8" cy="9" r="1" />
      <circle cx="12" cy="9" r="1" />
      <circle cx="16" cy="9" r="1" />
      <circle cx="8" cy="13" r="1" />
      <circle cx="12" cy="13" r="1" />
      <circle cx="16" cy="13" r="1" />
    </Icon>
  );
}

/** Стрелка вверх — плитка «Средний балл». */
export function IconScore(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v18M5 8l7-5 7 5" />
    </Icon>
  );
}

/** Часы — плитка «Ждут разбора». */
export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

/** Галочка — пройденный шаг разговора в `.rail`. */
export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

/** Пуск — кружок `.pl` внутри чипа-улики и кнопка `.play` мини-плеера. */
export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5v14l11-7z" />
    </Icon>
  );
}

/** Наушники станции — пустое состояние «Телефонии». */
export function IconStation(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12a8 8 0 0 1 16 0" />
      <rect x="3" y="12" width="4" height="7" rx="2" />
      <rect x="17" y="12" width="4" height="7" rx="2" />
    </Icon>
  );
}

/** Свернуть окно звонка — минус, как в `call-window-v2.html`. */
export function IconMinimize({ className, ...rest }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * Закрыть окно звонка — крестик той же сетки и той же толщины, что «свернуть».
 *
 * В макете `call-window-v2.html` кнопка в шапке одна, «свернуть»: окно там гасло
 * само по событию станции. В жизни оно висело до сорока секунд (сервер держит
 * завершённый звонок 20 секунд, опрос в этом состоянии шёл раз в 15), и владелец
 * 12.09.2026 назвал это «карточка звонка долго висит». Теперь окно закрывается
 * само через три секунды, а этот крестик — способ закрыть его прямо сейчас.
 */
export function IconClose({ className, ...rest }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Отбой в окне звонка — та же кривая и та же толщина 1.7, что в макете. */
export function IconHangUp({ className, ...rest }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M10.5 15.5 8 18a17 17 0 0 1-6-9L4.5 6.5 6 3h4l1.5 4L9 9.5a10 10 0 0 0 4.5 4.5L16 12l4 1.5v4l-3.5 1.5a17 17 0 0 1-6-3.5" />
    </svg>
  );
}
