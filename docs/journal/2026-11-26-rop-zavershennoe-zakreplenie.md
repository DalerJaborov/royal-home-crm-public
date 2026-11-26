# 26.11.2026: РОП работает с клиентами по завершённому закреплению

Решение владельца: РОП (HEAD_OF_SALES) может писать и звонить по клиентам, у которых закрепление завершено. Раньше исключение было у ADMIN и DIRECTOR.

- `assignmentWriteDenied` (apps/api/src/lib/assignmentCompletion.ts): набор ролей ADMIN, DIRECTOR, HEAD_OF_SALES.
- Вызывают: clientWriteAccess (карточка), showingAccess (задачи и показы), clients/propertyActivity (canManage), routes/conversations (ответы, пауза бота). Все получают РОП одинаково; проверка только по роли, остальные роли (агент, менеджер, оператор, служба безопасности) без изменений.
- Тест: apps/api/tests/assignment-completion-rop-access.test.ts.
