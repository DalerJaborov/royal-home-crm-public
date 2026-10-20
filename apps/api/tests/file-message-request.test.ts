import { describe, expect, it } from "vitest";
import { buildFileRequest, FileUnsupportedInChannelError, GRAPH_VERSION } from "../src/messengers/meta.js";

/**
 * ГИД ПОКУПАТЕЛЯ НЕ УХОДИЛ В WHATSAPP (найдено 25.08.2026, аудит утреннего
 * отчёта): `buildFileRequest` безусловно бросал «Файл в WhatsApp этим способом
 * не отправляется», а `lib/buyerGuide.ts` числит WhatsApp в FILE_CHANNELS и
 * честно пытается — каждый раз ловил этот throw, без файла и без объяснения
 * клиенту. WhatsApp Cloud API документы умеет (тот же приём, что уже работает
 * для голосовых, см. voice-messages.test.ts) — просто `type: "document"`.
 */

describe("Тело запроса файла у Meta различается по каналу", () => {
  const credentials = {
    waToken: "wa-token",
    waPhoneId: "phone-1",
    igToken: "ig-token",
    pageToken: "page-token",
    pageId: "page-1",
  };

  it("WhatsApp: type document, ссылка и имя в document.link/filename", () => {
    const req = buildFileRequest(credentials, "WHATSAPP", "992900000001", "https://crm/uploads/guide.pdf", "Гид покупателя.pdf");
    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/phone-1/messages`);
    expect(req.body).toEqual({
      messaging_product: "whatsapp",
      to: "992900000001",
      type: "document",
      document: { link: "https://crm/uploads/guide.pdf", filename: "Гид покупателя.pdf" },
    });
  });

  it("WhatsApp без имени файла — filename просто отсутствует по значению, запрос не падает", () => {
    const req = buildFileRequest(credentials, "WHATSAPP", "992900000001", "https://crm/uploads/guide.pdf");
    expect(req.body).toMatchObject({ type: "document", document: { link: "https://crm/uploads/guide.pdf" } });
  });

  it("WhatsApp без идентификатора номера — понятная ошибка, а не падение внутри Graph", () => {
    expect(() => buildFileRequest({}, "WHATSAPP", "992900000001", "https://x/guide.pdf")).toThrow();
  });

  it("Instagram: типизированный отказ БЕЗ похода в Graph — файлы там не существуют", () => {
    /**
     * 26.08.2026: attachment type "file" в Instagram Send API не поддерживается —
     * запрос стабильно бился о 400 subcode 2018007 на каждой выдаче чек-листа,
     * с двумя бесполезными ретраями и записью в журнал. Теперь отказ мгновенный,
     * и вызывающий код (leadMagnet/buyerGuide) штатно отдаёт ссылку.
     */
    expect(() => buildFileRequest(credentials, "INSTAGRAM", "igsid-1", "https://crm/uploads/guide.pdf")).toThrow(
      FileUnsupportedInChannelError
    );
  });

  it("Messenger: is_reusable и messaging_type RESPONSE", () => {
    const req = buildFileRequest(credentials, "FACEBOOK", "psid-1", "https://crm/uploads/guide.pdf");
    expect(req.body).toMatchObject({
      recipient: { id: "psid-1" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "file", payload: { url: "https://crm/uploads/guide.pdf", is_reusable: true } } },
    });
  });
});
