-- WhatsApp: своя переписка на каждый наш номер (владелец 26.11.2026, Arvan — второй номер).
--
-- В WhatsApp собеседник (subscriberId) — номер телефона, поэтому общий на канал
-- уникальный ключ (channel, subscriberId) не давал человеку, который уже писал на
-- Royal Home, завести переписку с номером Arvan. Ключ WhatsApp-переписки теперь —
-- (endpointScopeId, subscriberId): он уже есть и уже уникален
-- ("BotConversation_endpointScopeId_subscriberId_key"), а endpointScopeId каждой
-- строке ставит триггер customer_native_scope_insert.
--
-- Остальные каналы (Instagram, Facebook, сайт, YouTube) сохраняют прежнюю
-- уникальность частичным индексом. Данные не меняются: существующие строки уже
-- уникальны по старому ключу, значит и по обоим новым.
--
-- Откат: вернуть глобальный ключ можно, только пока ни у одного номера WhatsApp нет
-- переписок с двумя нашими номерами; поведение откатывается рубильником
-- WHATSAPP_CHAT_PER_NUMBER=off (lib/customerConversationScope.ts), а не миграцией.
DROP INDEX IF EXISTS "BotConversation_channel_subscriberId_key";
CREATE UNIQUE INDEX "BotConversation_channel_subscriberId_non_whatsapp_key"
  ON "BotConversation"("channel", "subscriberId") WHERE "channel" <> 'WHATSAPP';
CREATE INDEX "BotConversation_channel_subscriberId_idx" ON "BotConversation"("channel", "subscriberId");

-- Спутники переписки с тем же двойным ключом (старый на канал + новый по области):
-- без этой правки вторая переписка WhatsApp заводилась бы, а ответ в неё упирался бы
-- в старый ключ щита исходящих (lib/outboundShield.ts → compat_collision, бот молчит),
-- и отметка показа объекта (messengers/propertyShowcase.ts) не записывалась бы.
DROP INDEX IF EXISTS "OutboundShieldState_channel_subscriberId_key";
CREATE UNIQUE INDEX "OutboundShieldState_channel_subscriberId_non_whatsapp_key"
  ON "OutboundShieldState"("channel", "subscriberId") WHERE "channel" <> 'WHATSAPP';
-- Ключ строк без области: его выбирает ON CONFLICT ("channel","subscriberId") WHERE "endpointScopeId" IS NULL.
CREATE UNIQUE INDEX "OutboundShieldState_channel_subscriberId_unscoped_key"
  ON "OutboundShieldState"("channel", "subscriberId") WHERE "endpointScopeId" IS NULL;
CREATE INDEX "OutboundShieldState_channel_subscriberId_idx" ON "OutboundShieldState"("channel", "subscriberId");

DROP INDEX IF EXISTS "ShownProperty_channel_recipientId_shortId_key";
CREATE UNIQUE INDEX "ShownProperty_channel_recipientId_shortId_non_whatsapp_key"
  ON "ShownProperty"("channel", "recipientId", "shortId") WHERE "channel" <> 'WHATSAPP';
CREATE INDEX "ShownProperty_channel_recipientId_shortId_idx" ON "ShownProperty"("channel", "recipientId", "shortId");
