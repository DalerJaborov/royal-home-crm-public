// Обмен кода согласия Google на refresh_token и запись его в Settings (зашифрованно).
// Запуск внутри контейнера API: node yt-exchange.mjs "<code>"   |   node yt-exchange.mjs --check
// Секреты на экран не выводятся: только scope, http-код и последние 4 символа токена.
import { prisma } from "/repo/apps/api/dist/db.js";
import { decryptSecretSafe, encryptSecret } from "/repo/apps/api/dist/crypto.js";

const REDIRECT_URI = "https://developers.google.com/oauthplayground";
const arg = process.argv[2];

const s = await prisma.settings.findUnique({
  where: { id: "singleton" },
  select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
});
const clientId = s?.youtubeClientId;
const clientSecret = decryptSecretSafe(s?.youtubeClientSecret ?? null);
if (!clientId || !clientSecret) {
  console.log("NO_CLIENT_CREDS");
  process.exit(1);
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, body };
}

if (arg === "--check") {
  const rt = decryptSecretSafe(s?.youtubeRefreshToken ?? null);
  if (!rt) { console.log("NO_REFRESH_TOKEN"); process.exit(1); }
  const { http, body } = await tokenRequest({ grant_type: "refresh_token", refresh_token: rt });
  console.log(`http=${http} VERDICT=${http === 200 ? "TOKEN_ALIVE" : "TOKEN_DEAD"} scope=${body.scope ?? "-"} error=${body.error ?? "-"}`);
  await prisma.$disconnect();
  process.exit(http === 200 ? 0 : 2);
}

if (!arg) { console.log("USAGE: node yt-exchange.mjs <code> | --check"); process.exit(1); }
const code = decodeURIComponent(arg);
const { http, body } = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
if (http !== 200 || !body.refresh_token) {
  console.log(`http=${http} error=${body.error ?? "-"} desc=${body.error_description ?? "-"} has_refresh=${Boolean(body.refresh_token)}`);
  await prisma.$disconnect();
  process.exit(2);
}
await prisma.settings.update({
  where: { id: "singleton" },
  data: { youtubeRefreshToken: encryptSecret(body.refresh_token) },
});
console.log(`SAVED scope=${body.scope} tail=...${body.refresh_token.slice(-4)}`);
await prisma.$disconnect();
