import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Ответы помощника содержат markdown-ссылки на карточки — превращаем их в
 * навигацию роутера, остальное выводим как текст (никакого HTML от модели).
 * Одна функция на панель (AssistantPanel) и поле «Спросить» на Главной (HomeAsk):
 * раньше она жила в панели, и Главная показывала ссылки сырым `[Имя](/clients/ID)`.
 * Допускаются только внутренние пути, начинающиеся с «/».
 */
export function renderAssistantContent(text: string, onNavigate: () => void): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /\[([^\]]+)\]\((\/[^)\s]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <Link key={key++} to={m[2]} onClick={onNavigate} className="lk">
        {m[1]}
      </Link>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
