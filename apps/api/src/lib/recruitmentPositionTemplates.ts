import { recruitmentPositionInputSchema } from "@royal-home/shared";
import { VACANCY_FACTS, vacancyOfficeAddress, vacancyOfficeAddressTg } from "../ai/vacancyFacts.js";

/** Editable starting points approved by the owner. These are NOT current
 * openings: only an explicitly saved CRM position may be offered to candidates. */
export function recruitmentPositionTemplates() {
  return [
    { key: "real-estate-agent", ...recruitmentPositionInputSchema.parse({
      titleRu: "Агент по недвижимости", titleTg: "Агент оид ба амволи ғайриманқул",
      detailsRu: [VACANCY_FACTS.pay.salary, `При продаже ${VACANCY_FACTS.pay.commissionTotalPct}% комиссии: ${VACANCY_FACTS.pay.agentPct}% агенту, ${VACANCY_FACTS.pay.companyPct}% компании.`,
        VACANCY_FACTS.schedule, "Компания предоставляет обучение, наставника и лиды. Доход зависит от сделок и не гарантируется.", vacancyOfficeAddress()].join("\n"),
      detailsTg: ["Маоши собит нест: даромад аз фоизи аҳдҳо вобаста аст.",
        `Ҳангоми фурӯш ҳаққи хизмат ${VACANCY_FACTS.pay.commissionTotalPct}%: ${VACANCY_FACTS.pay.agentPct}% ба агент ва ${VACANCY_FACTS.pay.companyPct}% ба ширкат.`,
        "Кори пурравақт, ҷадвал озод; вазифа қабул ва фурӯхтани амвол аст. Ширкат омӯзиш, роҳнамо ва муроҷиати муштариёнро медиҳад. Даромад кафолат дода намешавад.", vacancyOfficeAddressTg()].join("\n"),
      isOpen: false, postCodes: [], keywords: [],
    }) },
    { key: "smm-videographer", ...recruitmentPositionInputSchema.parse({
      titleRu: "SMM-специалист / видеограф", titleTg: "Мутахассиси SMM / видеограф",
      detailsRu: ["Снимать недвижимость, монтировать Reels, вести социальные сети: от идеи до публикации.",
        "Работа очно в офисе в центре Душанбе, с понедельника по субботу. Удалённая работа не предусмотрена.",
        "Дружная команда, кофе, печенье и удобные условия в офисе.", vacancyOfficeAddress(),
        "Для отклика расскажите об опыте и пришлите до трёх лучших работ. Размер зарплаты и точные часы пока не опубликованы."].join("\n"),
      detailsTg: ["Наворбардории амвол, таҳрири Reels ва пешбурди шабакаҳои иҷтимоӣ: аз идея то нашр.",
        "Кор дар офис дар маркази Душанбе, аз душанбе то шанбе. Кори фосилавӣ пешбинӣ нашудааст.",
        "Дастаи дӯстона, қаҳва, кулчақанд ва шароити бароҳат дар офис.", vacancyOfficeAddressTg(),
        "Барои муроҷиат аз таҷрибаатон нақл кунед ва то се кори беҳтаринатонро фиристед. Маош ва соатҳои дақиқ ҳоло нашр нашудаанд."].join("\n"),
      isOpen: false, postCodes: [], keywords: ["контент"],
    }) },
  ];
}
