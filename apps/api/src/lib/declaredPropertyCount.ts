import { prisma } from "../db.js";

/**
 * ЧИСЛО ОБЪЕКТОВ НА КАРТОЧКЕ — ТОЛЬКО РАСТЁТ, НЕ ЗАМЕНЯЕТСЯ (владелец 18.09.2026,
 * живой случай Ахтам/Ноза).
 *
 * Разбор звонка (ai/callAnalysis.ts) и разбор сообщения (ai/chatPropertyCount.ts)
 * видят только ОДИН разговор, а он почти всегда про один конкретный объект:
 * 16.09 клиент назвал 4 объекта, а звонок 17.09 про снижение цены только
 * квартиры в ОВИРе тихо переписал карточку на 1 — не потому что объектов стало
 * меньше, а потому что в этом звонке прозвучал один адрес. Для бюджета «новая
 * сумма замещает старую» верно, для количества объектов — нет.
 *
 * `GREATEST` в одном UPDATE — атомарно, без гонки с параллельным разбором
 * другого звонка/сообщения того же клиента. Метка времени сдвигается только
 * когда число действительно выросло. Оспорить число агент может отдельной
 * заявкой (routes/clients/propertyCountDisputes.ts), но не поправить поле.
 *
 * Ошибки не бросаем: вызывающие — фоновые разборы, которые из-за этого поля
 * не должны падать (как и раньше, `.catch(() => {})`).
 */
export async function raiseSellerDeclaredPropertyCount(clientId: string, count: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Client"
    SET "sellerDeclaredPropertyCount" = GREATEST(COALESCE("sellerDeclaredPropertyCount", 0), ${count}),
        "sellerDeclaredPropertyCountAt" = CASE
          WHEN COALESCE("sellerDeclaredPropertyCount", 0) < ${count} THEN NOW()
          ELSE "sellerDeclaredPropertyCountAt"
        END
    WHERE id = ${clientId}
  `.catch(() => {});
}

/** Симметрично для покупателя («а если хочет купить несколько», 06.09.2026). */
export async function raiseBuyerDesiredPropertyCount(clientId: string, count: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Client"
    SET "buyerDesiredPropertyCount" = GREATEST(COALESCE("buyerDesiredPropertyCount", 0), ${count}),
        "buyerDesiredPropertyCountAt" = CASE
          WHEN COALESCE("buyerDesiredPropertyCount", 0) < ${count} THEN NOW()
          ELSE "buyerDesiredPropertyCountAt"
        END
    WHERE id = ${clientId}
  `.catch(() => {});
}
