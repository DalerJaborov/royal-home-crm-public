/** Канал в BotConversation.channel. Строка, а не enum: канал в схеме — строка,
 *  и это то самое место, где новый канал добавляется без миграции.
 *  Листовой модуль: его импортируют и websiteChat, и conversationDelivery, и
 *  sendBotMessage — раньше константа жила в websiteChat и замыкала цикл импортов. */
export const WEBSITE_CHANNEL = "WEBSITE";
