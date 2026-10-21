import { z } from "zod";
import { customerPublicToolParameters, customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerAgentCompanyInformationCallSchema,
  customerMutationCommandSchema, type CustomerAgentToolCall } from "@royal-home/shared";
import { customerAgentVacanciesCallSchema } from "@royal-home/shared";
import type { CustomerAgentToolDefinition } from "./customerAgentCore.js";

const descriptions: Record<CustomerAgentToolCall["name"], string> = {
  get_property_facts: "Проверенные цена, район, застройщик, характеристики и текущая доступность (availability) объекта либо объектов текущего публичного поста-подборки (publication_properties). На вопрос, ещё ли доступна квартира, прочти availability здесь. Если есть serverPublication и спрашивают варианты/подробности, сначала прочти этот инструмент. Не проси ссылку на уже известный объект. Не сохраняет контакт и не создаёт заявку.",
  get_agency_contact: "Официальный публичный номер для телефонных звонков. Не обещает доступность WhatsApp.",
  get_company_policy: "Проверенные правила агентства по комиссии, аренде, оплате, торгу и услугам.",
  get_company_information: "Публичный адрес офиса агентства, перечень услуг и часы связи сотрудников из существующих настроек. Это не адрес квартиры и не обещание времени звонка.",
  get_open_vacancies: "Актуальные открытые вакансии и опубликованные условия из CRM. Сначала прочти при вопросе о работе. Закрытые позиции не предлагай, зарплату не придумывай. Не читает анкеты других кандидатов и не принимает решение о найме.",
  search_public_properties: "До трёх публичных вариантов по прямо названным типу недвижимости или району и условиям. На просьбу ещё/другие варианты сохрани прежние явно названные условия и nextPage=true: без уже отправленных в этом обращении. Без изменения пожеланий/лида.",
  save_contact: "Предложить сохранить только явно названные в текущем сообщении имя/номер. Сервер отдельно проверит право и буквальное содержание.",
  save_job_application: "Сохранить текущие собственные сведения и материалы кандидата по выбранной открытой вакансии. Сервер сам берёт исходное сообщение и вложения: не передавай чужие ID, резюме или URL аргументами. Не назначает собеседование, не оценивает пригодность, не создаёт клиента. Успех только по receipt.",
  request_callback: "Запросить звонок при настоящем согласии клиента и известном допустимом номере. Успех только по receipt.",
  request_handover: "Передать явную просьбу сотрудника или жалобу о несостоявшемся звонке. topic — точный текст текущего сообщения, максимум500 символов.",
  book_showing: "Запросить показ выбранного объекта на однозначно указанное время. Дата/время и объект не угадываются.",
  reschedule_showing: "Перенести только принадлежащую текущему обращению запись с точным public reference и ожидаемой версией.",
  cancel_showing: "Отменить только явно выбранную текущую запись по точному public reference и версии, при прямой просьбе клиента.",
  ask_owner: "Записать точный вопрос клиента собственнику по текущему объекту. Не означает, что собственник уже ответил.",
};
/** Declarations are built from the SAME shared validators used at execution.
 * The adapter selects only actual capabilities; this function grants nothing. */
export function customerAgentToolDefinitions(available: readonly CustomerAgentToolCall["name"][]): CustomerAgentToolDefinition[] {
  if (new Set(available).size !== available.length) throw new TypeError("Duplicate customer tool selection");
  return available.map(name => {
    let parameters: Record<string, unknown>;
    if (name === "get_property_facts") parameters = customerPublicToolParameters("draft-2020-12");
    else if (name === "get_agency_contact") parameters = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "get_company_policy") parameters = z.toJSONSchema(customerAgentCompanyPolicyCallSchema.shape.args, { target: "draft-2020-12" });
    else if (name === "get_company_information") parameters = z.toJSONSchema(customerAgentCompanyInformationCallSchema.shape.args, { target: "draft-2020-12" });
    else if (name === "get_open_vacancies") parameters = z.toJSONSchema(customerAgentVacanciesCallSchema.shape.args, { target: "draft-2020-12" });
    else if (name === "search_public_properties") parameters = z.toJSONSchema(customerAgentPropertySearchCallSchema.shape.args, { target: "draft-2020-12" });
    else {
      const command = customerMutationCommandSchema.options.find(option => option.shape.name.value === name);
      if (!command) throw new TypeError("Unknown customer tool selection");
      parameters = z.toJSONSchema(command.shape.args, { target: "draft-2020-12" });
    }
    return { name, description: descriptions[name], parameters };
  });
}
export const CUSTOMER_AGENT_PUBLIC_TOOLS = Object.freeze(["get_property_facts", "get_agency_contact", "get_company_policy", "search_public_properties", "get_company_information", "get_open_vacancies"] as const);
