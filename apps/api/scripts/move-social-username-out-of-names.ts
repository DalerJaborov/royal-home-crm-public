/**
 * ВЫНУТЬ НИК СОЦСЕТИ ИЗ ИМЕНИ КАРТОЧКИ (разовый, 30.08.2026).
 *
 * Предыстория. Владелец: «Сделай так, чтобы ник в Instagram или любой соцсети
 * сохранялся для админа и директора, не для агентов, чтобы они с лёгкостью даже
 * через поиск могли их искать. Никнейм должен быть ВНУТРИ карточки, а не в
 * названии». Под это 30.08 заведены поля Client.socialUsername / socialChannel.
 *
 * Что уже исправлено в коде без этого скрипта:
 *  · новые карточки ник в имя не пишут (cardName в messengers/conversation.ts
 *    пропускает через looksLikeRealName), а сам ник кладётся в socialUsername;
 *  · выдача карточки вычищает ник и его канал тому, у кого нет права
 *    `clients.viewOrigin` (lib/clientOrigin.ts, withHiddenOrigin).
 *
 * Зачем тогда скрипт. У карточек, заведённых до 17.08.2026, ник до сих пор лежит
 * ПРЯМО В `fullName` («@nozil760», «raxxmanzadee»). Пока он там:
 *  · агенту он всё равно виден в каждом месте, куда имя уходит мимо выдачи —
 *    push-уведомление, календарь, доска сделок (та же беда, что с номером в имени,
 *    см. scripts/mask-phone-in-client-names.ts);
 *  · руководителю он бесполезен для поиска — искать надо по отдельному полю;
 *  · синтез речи давится об него на каждом проходе крона
 *    (lib/telephony/whisperText.ts, isSpeakablePiece).
 *
 * Что делает: если `fullName` — это ник (признак один на весь репозиторий:
 * looksLikeSocialUsername в lib/clientOrigin.ts), переносит значение в
 * `socialUsername`, проставляет `socialChannel` по источнику карточки, а в
 * `fullName` ставит принятую в проекте заглушку «Покупатель №1042» /
 * «Продавец №1042» / «Клиент №1042» — по виду карточки, с её коротким номером.
 *
 * Что теряется: ничего. Ник остаётся в базе рядом, в своём поле, и открыт
 * админу и директору.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/move-social-username-out-of-names.ts            — показать, что будет сделано
 *     npx tsx scripts/move-social-username-out-of-names.ts --apply    — выполнить
 *
 * Без `--apply` не пишет НИЧЕГО. Повторный запуск безопасен: у обработанных
 * карточек в имени стоит заглушка с пробелом и кириллицей, и признак ника её не
 * узнаёт. Карточки, у которых socialUsername уже заполнен, не трогаются.
 */
import { prisma } from "../src/db.js";
import { looksLikeSocialUsername } from "../src/lib/clientOrigin.js";
import { CLIENT_KIND_LABELS, formatClientCode } from "@royal-home/shared";
import type { ClientKind } from "@royal-home/shared";

/** Предел выборки обязателен — правило репозитория. Идём страницами по курсору:
 *  таких карточек могут быть сотни, все они старше 17.08.2026. */
const BATCH = 500;

/** Из какой сети ник. Источник карточки — единственное, что у нас об этом есть;
 *  для несоцсетевого источника (звонок, сайт) канал остаётся пустым, а ник всё
 *  равно сохраняется: он ценен сам по себе. */
const SOCIAL_CHANNELS = new Set(["INSTAGRAM", "TELEGRAM", "FACEBOOK", "WHATSAPP"]);

/**
 * Заглушка — ровно та, что ставит бот при приёме заявки (messengers/conversation.ts):
 * роль плюс номер карточки в общем формате «Покупатель ПК-000042». Свой формат здесь
 * писать нельзя — заглушка это ссылка на номер, и человек должен уметь скопировать её
 * в поиск клиентов, а `parseShortCode` понимает только ПК/ПР/ПО/ОБ (и старое КЛ — для
 * обратной совместимости поиска по уже сохранённым номерам).
 */
function placeholderName(kind: string, shortId: number): string {
  const k = (kind as ClientKind) ?? "OTHER";
  return `${CLIENT_KIND_LABELS[k] ?? "Клиент"} ${formatClientCode(shortId, k)}`;
}

type Row = {
  id: string;
  shortId: number;
  fullName: string;
  kind: string;
  source: string;
  socialUsername: string | null;
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  let cursor: string | undefined;
  let scanned = 0;
  const toFix: Array<Row & { name: string; username: string; channel: string | null }> = [];

  for (;;) {
    const page: Row[] = await prisma.client.findMany({
      where: { deletedAt: null },
      select: { id: true, shortId: true, fullName: true, kind: true, source: true, socialUsername: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]!.id;

    for (const c of page) {
      // Ник уже вынут раньше — второй раз не переписываем: в поле может лежать
      // значение, полученное из профиля, и оно точнее того, что было в имени.
      if (c.socialUsername) continue;
      if (!looksLikeSocialUsername(c.fullName)) continue;
      toFix.push({
        ...c,
        username: c.fullName.trim(),
        channel: SOCIAL_CHANNELS.has(c.source) ? c.source : null,
        name: placeholderName(c.kind, c.shortId),
      });
    }

    if (page.length < BATCH) break;
  }

  console.log(`Просмотрено карточек: ${scanned}`);
  console.log(`С ником вместо имени: ${toFix.length}`);
  for (const c of toFix) {
    console.log(
      `  КЛ-${String(c.shortId).padStart(6, "0")}: «${c.fullName}» → имя «${c.name}», ` +
        `ник «${c.username}»${c.channel ? `, сеть ${c.channel}` : ", сеть неизвестна"}`,
    );
  }

  if (!apply) {
    console.log(toFix.length > 0 ? "\nЗапустите с --apply, чтобы применить." : "\nМенять нечего.");
    return;
  }

  for (const c of toFix) {
    // Имя и ник — одна правка одной строки: разнести их по двум update значило бы
    // получить карточку без имени и без ника, если между ними оборвётся связь.
    await prisma.client.update({
      where: { id: c.id },
      data: { fullName: c.name, socialUsername: c.username, socialChannel: c.channel },
    });
  }
  console.log(`\nОбновлено карточек: ${toFix.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
