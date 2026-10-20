-- Роль оператора входящих и браузерный софтфон удалены целиком (решение владельца
-- 18.08.2026: «полное удаление этого кода и всех связей, он ведь даже нам больше не
-- нужен»). Колонки ниже обслуживали только их, читателей в коде не осталось.
--
-- Данные при этом теряются безвозвратно: `Agent.webrtcUser`/`webrtcPassword` — это
-- учётные записи браузерных трубок (перевыпускать больше нечего и нечем),
-- `Settings.incomingOperatorIds` — список операторов, `asteriskWebrtc*` — адреса и
-- пароль передатчика звука. Восстановление не предполагается: механизм удалён, а не
-- отключён. Журнал входящих, записи, расшифровки и автосоздание карточки по звонку
-- эти колонки не читают — они остаются как есть.

-- DropIndex
DROP INDEX "Agent_webrtcUser_key";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "webrtcPassword",
DROP COLUMN "webrtcUser";

-- AlterTable
ALTER TABLE "Settings" DROP COLUMN "asteriskWebrtcTurnPassword",
DROP COLUMN "asteriskWebrtcTurnUrl",
DROP COLUMN "asteriskWebrtcTurnUser",
DROP COLUMN "asteriskWebrtcWsUrl",
DROP COLUMN "incomingOperatorIds",
DROP COLUMN "telephonyRetryViaMobileEnabled",
DROP COLUMN "telephonyRingtoneEnabled";
