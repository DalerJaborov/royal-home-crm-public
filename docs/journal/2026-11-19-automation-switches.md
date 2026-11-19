# Выключатели «Автоматика ИИ и напоминания» (19.11.2026)

Владелец, дословно: «оставить все эти функции просто сделать переключатели эти функции очень полезные, а потом решим что выключить».

Ничего не удалено. У каждого механизма ниже появилась строка в Настройках → вкладка с «Работой с продавцами» (блок «Автоматика ИИ и напоминания»). По умолчанию всё ВКЛЮЧЕНО (`@default(true)`, миграция `20261119100000_automation_switches`): после выката поведение то же, что вчера. Выключенный механизм ничего не делает (ни записи, ни задачи, ни уведомления), остальной ход идёт как обычно.

Одна дверь: `apps/api/src/lib/automationSwitches.ts` (`automationSwitchOn(key)`, без кэша: api и worker разные процессы). Список, подписи, группы: `packages/shared/src/automationSwitches.ts`. Экран: `apps/web/src/pages/settings/AutomationSwitchesSection.tsx` (один на ПК и телефон). Сохранение: PATCH /settings (право `settings.manage`), в журнале действий видно, кто и что переключил.

| Поле | Что гасит | Где |
|---|---|---|
| `aiCardFromCallEnabled` | ИИ дописывает карточку по звонку. Выкл: нет записи в карточку, нет CardSuggestion, ИИ не зовём; автопилот (`lib/clientAutopilot.ts`) тоже не читает расшифровки звонков (`buildCardFillSuggestion(..., {includeCalls:false})`), заполнение из переписки идёт | `lib/cardSuggestions.ts`, `lib/clientAutopilot.ts`, `ai/cardFill.ts` |
| `aiAgentShowingAutoBookEnabled` | ИИ сам назначает показ по разговору АГЕНТА: переписка (`lib/operatorShowingDetector.ts`) и звонок (`ai/callAnalysis.ts`, блок «ПОКАЗ НАЗНАЧАЕТСЯ САМ»). Бот в своих ходах, голос робота, помощник и кнопки не затронуты | оба файла |
| `aiJobSeekerAutoDetachEnabled` | Автоматика не снимает агента и не переводит существующую карточку в кандидаты. Выкл: карточка как «keep» (анкета к ней не привязывается), анкета кандидата и уведомление руководству идут; звонок клиента с агентом ведёт себя как чат: анкета и уведомление есть, платный разбор модели пропускается (хватает слов расшифровки). Ручная кнопка «В кандидаты» работает | `lib/jobApplications.ts::candidateCardDecision` (чаты всех каналов и звонок незнакомого), `lib/telephony/autoLeadFromCall.ts::candidateFromAssignedClientCall` |
| `dealStaleSellersEnabled` | УЖЕ БЫЛ (14.11, блок «Работа с продавцами»): задача «Продавец без объекта — добавьте объект». Не дублируется: та же колонка, строка показана и в новом блоке | `lib/dealStalePipeline.ts` |
| `dealStaleBuyersEnabled` | Задача «Закройте сделку» покупателю | `lib/dealStalePipeline.ts` |
| `notifyClientWaitingEnabled` | ТОЛЬКО напоминание «клиент молчит 30 минут»: тик `silence`, сторож (WhatsApp/Instagram/Telegram) и его повтор. Сигналы поломки бота и передачи сотруднику (`escalate`, `failed`, `handover`) и «агент уточнит» (`follow_up`) идут всегда (ревью architect 19.11) | `lib/clientWaitingAlert.ts` |
| `notifyRobotTookCallEnabled` | «Робот взял звонок, послушайте» (`live-voice-listen-*`) | `lib/telephony/liveVoiceInboundPush.ts` |
| `notifyTrashAnomalyEnabled` | «Много удалений у агента» | `lib/clientTrashAnomalyAlarm.ts` |
| `notifyPropertyReviewOverdueEnabled` | «Объект долго на проверке» (`pending-review-overdue-*`), только уведомление | `lib/propertyPipeline.ts::notifyOverdueMaterials` |

Не тронуто нарочно: `stuckWork.ts` `client-waiting-given-up:` (звонок телефона, что ЗАДАНИЕ отправки ответа клиенту сдалось после повторов, часть «Что не доехало», а не сторож молчания), `live-voice-listener-*` (дедуп ошибок), `telegramSilenceWatchEnabled` (свой старый рубильник), автозаполнение карточки по ПЕРЕПИСКЕ (`lib/clientAutopilot.ts`: другой механизм).

Тесты: `tests/automation-switches.test.ts` (умолчание true, база, PATCH+журнал, «Много удалений»), OFF-случаи рядом с механизмами: card-auto-apply, operator-showing-detect, showing-auto-book, candidate-intake-channels, candidate-by-phone-call, deal-stale-pipeline-deadline, client-waiting-alert, live-voice-inbound-push, property-stuck-materials.
