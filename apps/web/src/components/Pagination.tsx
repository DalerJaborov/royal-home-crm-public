import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  variant = "classic",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /**
   * `rh2` — разметка эталона темы «Royal Home 2026» (`.pager` из
   * screens/comments.html: слева «Показаны N из M», справа «Назад»/«Вперёд»
   * пилюлями). Живёт здесь, а не копией на экране: правило «страница за краем
   * выдачи возвращается на последнюю» выше — общее, и разъезжаться ему нельзя.
   * Без пропа компонент выглядит ровно как раньше, остальные два десятка
   * списков не трогаются.
   *
   * Тип — объединение `"classic" | "rh2"` со значением по умолчанию, а не узкое
   * `"rh2"`: старый вид тогда можно назвать вслух (`variant="classic"`), а не
   * только пропуском пропа. При слиянии двух волн переноса это же объединение
   * приняло обе стороны без правки вызовов.
   *
   * `loadMore` — решение владельца (15.09.2026): страницы с номерами и «Назад/
   * Вперёд» на мобильном путают, список должен расти лентой. Кнопка одна —
   * «Показать ещё», зовёт тот же `onPageChange(page + 1)`, экран сам копит
   * строки (см. комментарий у места вызова на каждом перенесённом списке).
   * Кнопка гаснет, когда показано всё — как и в остальных вариантах.
   */
  variant?: "classic" | "rh2" | "loadMore";
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /**
   * СТРАНИЦА ЗА КРАЕМ ВЫДАЧИ ВОЗВРАЩАЕТСЯ НА ПОСЛЕДНЮЮ (03.09.2026).
   *
   * Владелец удалил партию объектов с третьей страницы, страниц осталось две — и
   * экран показал «Под этот фильтр объектов нет», «41–40 из 40» и «3 / 2»:
   * список цел, но выглядит пустым, а вернуться нечем — кнопка «вперёд» погашена,
   * «назад» ведёт на 2-ю, будто третья существует. То же самое случалось от любого
   * сужения выдачи на последних страницах (удаление, фильтр, чужая ссылка с ?page=99).
   *
   * Правка живёт здесь, а не на экране объектов: страницу держат полтора десятка
   * списков, и каждый чинить своим useEffect значило бы пятнадцать копий одного
   * правила. Сброс делается ДО раннего return — иначе выдача, ужавшаяся до одной
   * страницы (или до нуля строк), теряла бы пагинацию вместе с шансом сброситься,
   * и человек оставался бы на пустой странице навсегда. Ранний return после хуков —
   * ещё и правило хуков: хук после return однажды уже ронял карточку объекта в проде.
   */
  useEffect(() => {
    if (page > totalPages) onPageChange(totalPages);
  }, [page, totalPages, onPageChange]);

  if (totalPages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  if (variant === "loadMore") {
    if (page >= totalPages) return null;
    return (
      <div className="flex items-center justify-center px-4 py-3">
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          className="pill ghost sm"
        >
          Показать ещё ({total - to})
        </button>
      </div>
    );
  }

  if (variant === "rh2") {
    return (
      <div className="pager">
        <span className="info">
          Показаны с {from} по {to} из {total}
        </span>
        <button
          type="button"
          className="pill ghost sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Назад
        </button>
        <span className="chip mute">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          className="pill ghost sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Вперёд
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-t border-line-soft">
      <span className="text-[15px] text-gray-500">
        с {from} по {to} из {total}
      </span>
      <div className="flex-1" />
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Предыдущая страница"
        className="tap-target flex items-center justify-center w-7 h-7 rounded-lg border border-line text-gray-600 hover:bg-hover-tint disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <span className="text-[15px] font-semibold text-gray-700 tabular-nums">
        {page} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Следующая страница"
        className="tap-target flex items-center justify-center w-7 h-7 rounded-lg border border-line text-gray-600 hover:bg-hover-tint disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
