# HANDOFF 14.11.2026 — озвучка: простой экран для агента, техника в Настройки CRM

Worktree: `C:/Users/Daler/.claude/worktrees/narration-ux`, ветка `feat/narration-agent-simple-14-11` (от origin/main 00058afa8).
Окружение НЕ поднято: сначала связать node_modules (как `setupTree()` в `scripts/agent-stand.mjs`, главное дерево D:/CRM — на ЧУЖОЙ ветке, его не трогать), `npm run build:shared && npm run prisma:generate`.

## Просьба владельца (дословно, суть)
«Всю техническую часть полностью убирать надо в настройки CRM. Тем более в настройках объекта этого вообще не должно быть. … в конце надо выбрать просто голос … Сначала выбирается озвучка, потом сразу текст ставится, который по шаблону меняется лишь там, допустим, цифры. … несколько шаблонов, чтобы не каждый раз одинаковые, … агент сам менять текст. И нажать кнопку генерировать … UX UI дизайн, чтобы без багов работало идеально.»
Второй вопрос (14.11): «проверить, всё ли правильно работает, если агенты отправят ролики на перемонтаж только аудио — изменили цену, скидка — чтобы без монтажёра на старый ролик просто новая озвучка; что делать с музыкой под голос, чтобы друг другу не мешали».

## Сделано (код написан, НЕ собрано, НЕ прогнано)
- shared `propertyNarration.ts`: `narrationTemplateLangs`, `nextNarrationTemplateId`, `narrationRotatedTemplateId` (варианты по кругу), тип `NarrationSettingsView`, поле `facts` в `PropertyNarrationView`.
- api `routes/properties/narration.ts`: GET /narration-settings отдаёт canConfigure/configured/autoGenerate/samplesReady/budget; GET /:id/narration отдаёт `facts`.
- api `lib/narrationAutoFlow.ts::startNarrationForNewProperty`: без выбора шаблона — следующий вариант после прошлого (мастер CRM и Шабнам).
- web: новый `components/NarrationComposer.tsx` (1 Голос: язык + плитки с ▶; 2 Текст: варианты, «↻ Другой вариант», правка, «Вернуть текст шаблона»; `resolveNarrationDraft`).
- web: `PropertyNarrationManager.tsx` переписан: статус (готовится с опросом 5 с / послушайте и одобрите / одобрено / устарело / не получилось) + composer + одна кнопка «Озвучить». Служебное — `PropertyNarrationService.tsx` (свёрнуто, только canApprove/canConfigure).
- web: `components/settings/NarrationSettingsPanel.tsx` (модель, голоса, образцы, рубильники, пределы, шаблоны, словарь) смонтирован в `pages/settings/ChannelsTab.tsx` (публикация) секцией «Озвучка роликов»; `parseVoiceLines` переехал туда.
- web: `VoiceSamplePicker` — плитки 2/4 в ряд; `property-wizard/NarrationChoice.tsx` на NarrationComposer.
- Тесты: `apps/api/tests/narration-template-rotation.test.ts` (новый), `PropertyNarrationManager.test.tsx` (переписан), `NarrationChoice.test.tsx` (импорт parseVoiceLines).

## Осталось
1. Сборка shared/api/web, `test:web`, тесты narration-* в api (особенно `narration-montajer-audio`, `narration-auto-flow` — ротация шаблона могла поменять ожидания), тест для NarrationSettingsPanel.
2. Проверка вопроса владельца про смену цены (см. ниже) — прочитать `lib/narrationMix.ts`, `narrationAutoFlow.ts::remixFromMasters/afterNarrationApproved`, `narrationVoicelessCopy.ts`, тест `narration-crm-mix.test.ts`; прогнать настоящий ffmpeg на образце: ролик с музыкой + mp3 → проверить ducking на слух/по громкости.
3. Кадры ПК + телефон (карточка объекта, мастер, Настройки → Каналы), обе темы; `npm run map`, `map:check`, `gen:typeset` если CSS; журнал `docs/journal/2026-11-14-narration-agent-ux.md`; precheck; draft PR; ship по правилам проекта.

## Что уже известно про смену цены (ФАКТ из кода)
- `narrationMix.ts`: голос поверх, музыка ролика приглушается под голосом сама (sidechaincompress, ducking), между фразами возвращается; голос стартует через 0,3 с; озвучка длиннее ролика — отказ VOICE_LONGER (не обрезается).
- Без голоса-копии (ролики до 12.11 или монтажёр её не прислал) → SOUND_REMAKE, монтажёру «замените только голос».
- Риск для проверки: новая цена словами длиннее → VOICE_LONGER; громкость музыки 0.8 и порог 0.03 не проверены на слух владельцем.
