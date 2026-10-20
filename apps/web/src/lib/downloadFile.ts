import { api } from "./api";

/**
 * СКАЧИВАНИЕ ФАЙЛА ИЗ CRM — ТОЛЬКО ЧЕРЕЗ `api()`, НИКОГДА ССЫЛКОЙ БРАУЗЕРА.
 *
 * CRM авторизует по заголовку `Authorization: Bearer` (api auth/middleware.ts).
 * Обычные `<a href="/api/v1/...">` и `<img src="/api/v1/...">` этот заголовок не
 * посылают: браузер уходит за файлом сам, сервер отвечает 401, и человек видит
 * пустую вкладку или «ничего не скачалось» — без ошибки, без записи в журнале.
 * Куки-сессии, на которую можно было бы опереться, у access-токена нет: в куке
 * живёт только refresh.
 *
 * Эту поломку уже ловили 10.08.2026 на записи разговора (см. докстринг
 * `CallRecording` в components/CallDetails.tsx) и чинили там же, по месту. Два
 * места остались с прежними ссылками и не работали до 19.09.2026: документ
 * сделки и шаблоны импорта в «Настройках». Чтобы третьего раза не было, приём
 * вынесен в один модуль, а сторож `lib/__tests__/noApiHrefs.test.ts` не даёт
 * снова написать ссылку браузера на адрес CRM.
 */

/** Забирает файл с адреса CRM и отдаёт браузеру на скачивание под именем `filename`. */
export async function downloadFromApi(path: string, filename: string): Promise<void> {
  const blob = await api<Blob>(path, { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Ссылку на объект обязательно отзываем: иначе файл остаётся в памяти вкладки
  // до перезагрузки страницы, а документы сделок бывают по несколько мегабайт.
  URL.revokeObjectURL(url);
}
