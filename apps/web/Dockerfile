# Веб-клиент Royal Home CRM — сборка Vite + раздача через nginx.
# Контекст сборки — корень репозитория: docker build -f apps/web/Dockerfile .

FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
# Общий пакет — отдельным слоем и ДО ARG GIT_SHA (11.09.2026).
# GIT_SHA меняется на КАЖДОМ выкате (это короткий хеш коммита), поэтому всё, что
# стоит ниже `ENV GIT_SHA`, кэшу недоступно по определению. Пока сборка shared
# лежала в одном RUN со сборкой web, она попадала в эту зону и выполнялась
# каждый раз заново. Теперь она выше границы и кэшируется, пока не менялся сам
# packages/shared.
COPY packages/shared packages/shared
RUN npm run build --workspace=packages/shared
COPY apps/web apps/web
# КЛЮЧ ЯНДЕКС-КАРТ ВПЕКАЕТСЯ НА ЭТАПЕ СБОРКИ (аудит №4, 27.08) — заголовок был
# здесь с 27.08, а самого `ARG` для ключа не было ни разу (дизайн-проход
# 14.09.2026, найдено на живом проде: карта тихо работала на бесплатном
# OpenStreetMap вместо купленных тайлов Яндекса всё это время — `import.meta.
# env.VITE_YANDEX_TILES_KEY` в собранном бандле был `undefined`, а `PropertyMap
# Explorer.tsx` в этом случае молча уходит на OSM, без единой ошибки). Заведён
# по образцу GIT_SHA ниже: `docker-compose.prod.yml` (`web.build.args`) должен
# прокинуть значение из `.env.production` на VPS.
#
# GIT_SHA — версия сборки для автообновления вкладок (задача P2, 08.09.2026, см.
# vite.config.ts/lib/appUpdate.ts). Vite подставляет import.meta.env.* в момент
# build, и другого пути у хеша нет: образ не содержит .git (**/.git в
# .dockerignore), значит донести его до `vite build`, кроме build-arg из compose
# (web.build.args), нечем. Пустое значение безвредно — vite.config.ts
# откатывается на момент сборки (Date.now()).
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
ARG VITE_YANDEX_TILES_KEY=""
ENV VITE_YANDEX_TILES_KEY=$VITE_YANDEX_TILES_KEY
RUN npm run build --workspace=apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
