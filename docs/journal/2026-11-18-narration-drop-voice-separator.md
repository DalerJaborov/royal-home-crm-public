# 18.11.2026 — Машинное отделение старого голоса убрано целиком (убрано намеренно, решение владельца 18.11)

- Что изменилось:
  - удалены сервис `apps/voice-separator` (Python, MDX Kim_Vocal_2 + faster-whisper), `lib/voiceSeparator.ts`,
    `lib/narrationAutoMaster.ts`, задача крона `narration-auto-master`, ответ одобрения `CRM_SEPARATE`;
  - рубильник «CRM сама убирает старый голос» (`autoSeparateVoice`, `narrationAutoSeparate`) убран из общей схемы,
    экрана Настройки → Озвучка и текстов монтажёру; сохранённое значение в настройках молча отбрасывается схемой;
  - `docker-compose.prod.yml` — без сервиса `voice-separator` и переменной `VOICE_SEPARATOR_URL`; `ops/deploy.sh` —
    без шага 3.1; `ops/auto-deploy.sh` — без правила для `apps/voice-separator/*`;
  - миграция `20261118200000_narration_drop_machine_separation`: мастера, сделанные машиной (`videoMasterSource = 'MACHINE'`),
    отвязаны от объектов (в них мог остаться старый голос — перемикс положил бы новый голос поверх старого), колонки
    `Property.videoMasterAuto*` удалены;
  - строка в карточке (`narrationMixNoteFor`) переехала в `lib/narrationAutoFlow.ts` без машинных веток;
  - монтажёра снова просят прислать к готовому ролику тот же ролик без голоса (как до 16.11): без машины это
    единственный путь сменить цену без него.
- Почему: владелец 18.11 — «удаляй всё… отделение музыки… убери полностью из кода». На проде отделение не убрало
  голос ни в одном из трёх роликов. Вместо него — своя библиотека музыки (следующая запись журнала).
- Не тронуто: ручной мастер от монтажёра (`storeNarrationMaster`, `remixFromMaster`), `planNarrationFit`, подгонка
  длины, «прослушать перед выпуском» (#272), колонки `videoMasterStorageKey` / `videoMasterSource`.
- Чем проверено: `apps/api/tests/narration-remix-fit.test.ts` (бывший `narration-auto-separate.test.ts`: план длины,
  стоп-кадр, (а)–(г) и идемпотентность теперь на ролике без голоса от монтажёра), `narration-auto-flow`,
  `narration-montajer-audio`, `narration-preview*`, `narration-crm-mix`, `narration-delivery`; `npm run map`,
  `MAP_GATE_ALLOW_REMOVALS=1 npm run precheck`.
- Что осталось (на сервере, только с «да» владельца): остановить и удалить старый контейнер `voice-separator`
  (`docker compose … up -d` его больше не трогает, он останется сиротой) и образ `royalhome-voice-separator` (~1,8 ГБ).
- Риск выката: колонки удаляются миграцией до пересоздания контейнеров (ops/deploy.sh, шаг 2.5); старые api/worker
  до перезапуска (десятки секунд) получат «column does not exist» на чтении объектов.
