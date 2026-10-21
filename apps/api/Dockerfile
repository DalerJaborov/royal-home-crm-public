# API Royal Home CRM — многоэтапная сборка npm-workspaces монорепо.
# Контекст сборки — корень репозитория: docker build -f apps/api/Dockerfile .

FROM node:24-slim AS build
# Prisma's migration CLI still ships a native schema engine. Detect the same
# OpenSSL ABI here as in the runtime, so startup never downloads another engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Сначала только манифесты — слой npm ci кешируется, пока не меняются зависимости.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
# Общий пакет собирается ОТДЕЛЬНЫМ слоем и ДО копирования apps/api (11.09.2026).
# Раньше сборка shared стояла внутри одного RUN вместе со сборкой api, а значит
# пересобиралась при каждой правке любого файла сервера — то есть на каждом
# выкате. packages/shared меняется куда реже, чем apps/api, поэтому здесь слой
# кэшируется, и обычный выкат «поправили роут» этот шаг больше не выполняет.
COPY packages/shared packages/shared
RUN npm run build --workspace=packages/shared
COPY apps/api apps/api
# Генерация через npm-скрипт воркспейса, а не `npx prisma --schema ...`: в
# Prisma 7 CLI берёт настройки из `prisma.config.ts`, а тот ищется от текущего
# каталога. Скрипт воркспейса выполняется в `apps/api`, где конфиг и лежит.
# Клиент теперь генерируется в `apps/api/src/generated/prisma`, поэтому tsc
# ниже кладёт его в `dist` вместе с остальным кодом — отдельного копирования
# `node_modules/.prisma` в готовый образ больше не требуется.
# tsc сервера перерос кучу по умолчанию (~2 ГБ в контейнере): 08.10.2026 сборка
# падала «heap out of memory» на 2001 МБ. Потолок поднят только для сборки.
RUN npm run prisma:generate --workspace=apps/api \
  && NODE_OPTIONS=--max-old-space-size=3584 npm run build --workspace=apps/api \
  && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
# Клиент Prisma 7 использует `pg`, но CLI миграций по-прежнему требует native
# schema engine под runtime OpenSSL. Сборка выше должна упаковать тот же ABI.
# ffmpeg нужен двум путям сразу:
#  - голосовые агента: браузер пишет webm/opus, WhatsApp Cloud API принимает только
#    ogg/opus (lib/audioTranscode.ts);
#  - музыка ожидания и приветствие автоответчика: Asterisk понимает 8 кГц моно
#    (lib/telephony/audioTranscode.ts);
#  - сжатие сырого ролика объекта (jobs/clipCompress.ts) и замер длительности
#    (lib/ffmpeg.ts::probeDurationSec).
#
# chromium и fonts-liberation убраны 04.09.2026 вместе с автомонтажом: chromium
# ставился РАДИ системных библиотек скачанного Remotion'ом Chrome Headless
# Shell, fonts-liberation — ради drawtext/libass в старом lib/video/*.ts. Ни
# того, ни другого в коде больше нет.
#
# fontconfig ВОЗВРАЩЁН 21.09.2026 вместе с fonts-dejavu-core (карточка-история
# объекта, lib/video/storyCard.ts): sharp рисует текст на картинке через
# librsvg/pango, а те берут шрифты из системного fontconfig — без него и без
# файлов шрифтов кириллический текст выходит прямоугольниками-заглушками, и
# ни сборка, ни vitest этого не замечают (растровое сравнение никто не
# гоняет). DejaVu Sans взят вместо Noto — полное покрытие кириллицы при
# заметно меньшем весе пакета.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ffmpeg ca-certificates fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
# Сохраняем структуру монорепо: symlink node_modules/@royal-home/shared -> ../../packages/shared
# остаётся валидным. Сам клиент Prisma с версии 7 лежит не в node_modules, а в
# `dist/generated/prisma` — он приезжает вместе с dist.
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
WORKDIR /repo/apps/api
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
COPY --from=build /repo/apps/api/package.json ./package.json
# `prisma.config.ts` нужен в образе: контейнер стартует с `npx prisma migrate
# deploy`, а CLI Prisma 7 без конфига не знает ни пути к схеме, ни адреса базы.
# Рабочий каталог здесь уже /repo/apps/api, конфиг ложится рядом со схемой.
COPY --from=build /repo/apps/api/prisma.config.ts ./prisma.config.ts
# apps/api/assets ВОЗВРАЩЁН 14.09.2026 (был удалён 04.09 — тогда в нём лежали
# только шрифты/шаблоны автомонтажа, больше не нужные) — теперь здесь offline-
# сконвертированные raw PCM живого офисного амбиента (live-voice-ambience/,
# см. liveVoiceBridge.ts::loadOfficeAmbienceTracks), путь к которым считается от
# скомпилированного файла через import.meta.url, а не от process.cwd().
COPY --from=build /repo/apps/api/assets ./assets
# Шрифт обложек соцсетей (lib/video/coverPoster.ts, assets/fonts/cover/) —
# тот же принцип, что у DejaVu Sans выше: librsvg/pango резолвят
# font-family по имени через СИСТЕМНЫЙ fontconfig, файл обязан физически
# лежать в каталоге шрифтов, одного copy в ./assets недостаточно.
RUN mkdir -p /usr/share/fonts/truetype/royal-home-cover \
  && cp ./assets/fonts/cover/*.ttf /usr/share/fonts/truetype/royal-home-cover/ \
  && fc-cache -f
RUN mkdir -p /app/uploads
# Check the actual final image, not only the builder. Missing/wrong engine must
# fail the build even when binaries.prisma.sh would be reachable on the host.
RUN --network=none node /repo/node_modules/prisma/build/index.js --version
EXPOSE 4000
# migrate deploy при каждом старте — идемпотентно, применяет только новые миграции.
# exec обязателен: без него PID 1 — sh, который НЕ пересылает SIGTERM ребёнку,
# и мягкая смерть из index.ts не срабатывает никогда (Docker ждёт grace period
# и добивает SIGKILL'ом — проверено на проде 26.08.2026).
# `npm run prisma:migrate:deploy` — намеренно не `npx prisma`. CLI Prisma
# переехал из devDependencies в обычные зависимости именно ради этой строки:
# `npm prune --omit=dev` выше его раньше выбрасывал, и `npx` при каждом старте
# контейнера тянул из реестра ВЕРСИЮ `latest` — сегодня это 8.0.0-rc. Наш
# клиент сгенерирован 7.10.0; накатывать миграции на прод кандидатом в релиз
# следующего мажора нельзя. Скрипт же зовёт ровно тот CLI, что лежит в образе.
CMD ["sh", "-c", "npm run prisma:migrate:deploy && exec node dist/index.js"]
