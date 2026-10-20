import { useId } from "react";
import {
  AVATAR_GEOMETRY,
  GENDER_LABEL,
  CLIENT_AVATAR_TONES,
  GENDER_RING_COLOR,
  PERSON_ICON_PATHS,
  clientAvatarTone,
  guessGenderFromName,
} from "@royal-home/shared";

/**
 * Аватар клиента — один вид на список, карточку и шторку уведомлений телефона.
 *
 * Всё, что определяет ВИД (палитра, хэш имени, словарь имён, контуры значков,
 * пропорции), живёт в packages/shared/src/clientAvatar.ts — там же объяснено, почему
 * слоя три и почему пол только угадывается. Здесь — исключительно отрисовка.
 *
 * Рисуем SVG, а не div с рамками, по трём причинам: кольцо задаётся долями диаметра и
 * потому одинаково точно на 32 и на 96 пикселях; на retina ничего не мылится; и ровно
 * тот же набор примитивов сервер выводит в картинку для пуша, так что расхождение
 * между CRM и телефоном становится невозможным, а не «маловероятным».
 *
 * Значок «покупатель/продавец» в углу убран 21.09.2026 (решение владельца — агенты
 * путали клиентов по совпавшему значку; тип виден текстом там, где нужен: вкладки,
 * фильтры). `kind` сюда больше не передаётся.
 *
 * Цвета намеренно НЕ токены темы: см. комментарий к палитре в shared. Кружок — своя
 * плашка, он должен читаться одинаково на всех темах CRM и на чёрной шторке Android.
 */

/** Единицы viewBox: кружок — диаметр 100 с центром (50,50), поле шире под кольцо и значок. */
const D = 100;
const R = D / 2;
const PAD = 10;

/**
 * Тона набора 06.10.2026 для строк списков (`palette="tokens"`): пять насыщенных
 * токенов `.rh2` с белой фигуркой вместо восьми пастелей. Индекс берётся из того
 * же хэша имени (`clientAvatarTone`), поэтому один клиент остаётся одним цветом
 * везде внутри списка, но различимых цветов пять, а не восемь: плата за единую
 * палитру контракта (записано в отчёте F1).
 */
const TOKEN_TONES = ["lime", "aqua", "lav", "pink", "sky"] as const;

export function ClientAvatar({
  fullName,
  avatarUrl,
  size = 38,
  className = "",
  palette = "own",
}: {
  fullName: string | null | undefined;
  /** Настоящее фото из мессенджера. Есть — всегда главнее нарисованного кружка. */
  avatarUrl?: string | null;
  /** Диаметр кружка в пикселях; кольцо слегка выходит за него, как принято. */
  size?: number;
  className?: string;
  /**
   * `own` (по умолчанию): восемь пастелей и кольцо пола, общий вид с пушем.
   * `tokens`: токены набора, без кольца (строки списка клиентов, контракт 06.10:
   * «не чипом и не кольцом»). Пол остаётся в `aria-label`.
   */
  palette?: "own" | "tokens";
}) {
  // Идентификатор обрезки обязан быть уникальным на странице: в списке этих аватаров
  // два десятка, и одинаковые id молча склеили бы их обрезки в одну.
  const clipId = useId();
  const own = clientAvatarTone(fullName);
  const tokens = palette === "tokens";
  const tokenName = TOKEN_TONES[CLIENT_AVATAR_TONES.indexOf(own) % TOKEN_TONES.length]!;
  const tone = tokens ? { bg: `var(--rh-${tokenName})`, fg: `var(--rh-${tokenName}-ink)` } : own;
  // Фото уже показывает человека — догадка о поле рядом с ним была бы в лучшем случае
  // шумом, в худшем противоречием тому, что агент видит своими глазами.
  const gender = avatarUrl ? null : guessGenderFromName(fullName);

  const label = [fullName?.trim() || "Клиент без имени", gender ? GENDER_LABEL[gender] : null]
    .filter(Boolean)
    .join(", ");

  const person = D * AVATAR_GEOMETRY.person;
  const ringW = D * AVATAR_GEOMETRY.ring;
  const ringR = R + D * AVATAR_GEOMETRY.ringGap + ringW / 2;

  return (
    // Занимаемое место — ровно диаметр кружка, как у прежних кружков-инициалов, чтобы
    // компонент можно было подставить в готовую строку списка, ничего не переверстав.
    // Само поле SVG шире и выходит за границы (overflow-visible): кольцо и значок в
    // углу обязаны выступать, иначе их пришлось бы уменьшать до нечитаемости.
    <span
      className={`relative inline-block shrink-0 align-middle ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`${-PAD} ${-PAD} ${D + PAD * 2} ${D + PAD * 2}`}
        className="absolute overflow-visible"
        style={{
          width: size * ((D + PAD * 2) / D),
          height: size * ((D + PAD * 2) / D),
          left: -size * (PAD / D),
          top: -size * (PAD / D),
        }}
      >
        {avatarUrl ? (
          <>
            {/* Круглая обрезка фото — тем же кругом, что и заливка ниже: одна геометрия
                на оба состояния, поэтому фото и нарисованный кружок не «прыгают»
                размером, когда аватар наконец скачался. */}
            <clipPath id={`ca-clip-${clipId}`}>
              <circle cx={R} cy={R} r={R} />
            </clipPath>
            <image
              href={avatarUrl}
              x={0}
              y={0}
              width={D}
              height={D}
              preserveAspectRatio="xMidYMid slice"
              clipPath={`url(#ca-clip-${clipId})`}
            />
          </>
        ) : (
          <>
            <circle cx={R} cy={R} r={R} style={{ fill: tone.bg }} />
            {/* Фигурка — обычный lucide-значок, отрисованный контурами: тот же набор и
                та же толщина обводки, что у всех остальных значков CRM. */}
            <g
              transform={`translate(${R - person / 2} ${R - person / 2}) scale(${person / 24})`}
              fill="none"
              style={{ stroke: tone.fg }}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {PERSON_ICON_PATHS.map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
          </>
        )}

        {/* Кольцо пола — незамкнутого вида не делаем: тонкая ровная линия в приглушённом
            тоне читается как оформление, а не как значок «онлайн» или тревога. */}
        {gender && !tokens && (
          <circle cx={R} cy={R} r={ringR} fill="none" stroke={GENDER_RING_COLOR[gender]} strokeWidth={ringW} />
        )}
      </svg>
    </span>
  );
}
