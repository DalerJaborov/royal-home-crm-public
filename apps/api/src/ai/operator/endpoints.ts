/**
 * Имена точек вызова модели у оператора заявок — отдельным листовым модулем без импортов (ревью #450): их читает дверь
 * денежного потолка (lib/customerBotSpendCap.ts), которую зовёт ai/client.ts, и импорт понимания или «своими словами»
 * целиком замкнул бы круг client → потолок → оператор → client.
 */
export const OPERATOR_UNDERSTAND_ENDPOINT = "lead-only-operator";
export const OPERATOR_COMPOSE_ENDPOINT = "lead-only-operator-compose";
