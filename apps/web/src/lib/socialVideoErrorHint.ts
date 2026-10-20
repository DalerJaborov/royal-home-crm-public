/** Keep transport failures separate from provider refusals and account setup. */
export function socialVideoErrorHint(retriable: boolean, error?: string | null): string {
  if (/\b(?:UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/.test(error ?? "")) {
    return "Сервер не смог соединиться с площадкой. Повторите публикацию чуть позже.";
  }
  return retriable
    ? "Площадка просит подождать. Это не поломка: повторите публикацию чуть позже."
    : "Проверьте, что канал подключён в «Настройки → Каналы связи», а ролик подходит под правила площадки, и повторите публикацию. Если ошибка повторяется — перешлите её текст разработчику.";
}
