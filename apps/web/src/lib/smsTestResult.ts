/** Provider acknowledgement is not handset delivery. Unknown responses must not claim a send. */
export function smsTestResultLabel(status?: string): string {
  if (status === "DRY_RUN") return "Проверочное СМС подготовлено в тестовом режиме. Клиенту ничего не отправлено.";
  if (status === "SENT") return "Провайдер принял проверочное СМС. Получение на телефоне пока не подтверждено.";
  return "Результат отправки не подтверждён. Проверьте журнал СМС перед повтором.";
}
