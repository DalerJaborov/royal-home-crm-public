import { customerMutationCommandSchema, type CustomerMutationCommand, type CustomerPropertyAdmission } from "@royal-home/shared";
import { prisma } from "../db.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { authenticatedInputMatchesFence, inspectAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { assertCustomerFence, customerActionCapability, loadAcceptedCustomerState, transitionCustomerState } from "./customerState.js";
import { customerMutationDigest, customerMutationKind } from "./customerActionCommand.js";

const REPORTED_OR_NEGATED = /[«»"“”]|(?<![\p{L}])(?:не\s+(?:надо|хочу|нужно|нужен|нужна|нужны|стоит|следует|записывайте|отменяйте|переносите|спрашива[\p{L}]*|уточня[\p{L}]*|передава[\p{L}]*)|(?:лозим|даркор)\s+нест|намехо[ҳх]ам|напурсед|нафиристед|гуфт(?:анд)?|написал(?:а|и)?|он\s+сказал|навишт)(?![\p{L}])/iu;
const HUMAN_TARGET = "(?:жив(?:ой|ого)\\s+)?(?:оператор(?:а|у|ом)?|сотрудник(?:а|у|ом)?|человек(?:а|ом)?|менеджер(?:а|у|ом)?|агент(?:а|у|ом)?)";
const HANDOVER_REQUEST = new RegExp(`(?<![\\p{L}])(?:(?:соедините|позовите|пригласите|переключите)[^.!?\\n]{0,40}|(?:хочу|можно|могу)\\s+(?:поговорить|связаться|пообщаться)\\s+(?:с|со)\\s+|(?:мне\\s+)?(?:нужен|нужна|нужны|хочу|прошу)\\s+)${HUMAN_TARGET}(?![\\p{L}])`, "iu");
const HANDOVER_NOT_REQUEST = /(?<![\p{L}])(?:кто\s+такой|что\s+(?:значит|означает)|(?:вам|у\s+вас)\s+нуж(?:ен|на|ны))(?![\p{L}])/iu;
const BARE_HANDOVER = /^(?:(?:пожалуйста|илтимос)[,\s]*)?(?:оператор(?:а)?|живой\s+человек|корманд|бо\s+одам)[.!?\s]*$/iu;
const HANDOVER_TG = /(?<![\p{L}])(?:бо\s+(?:корманд|оператор|одам)\s+(?:гап|суҳбат|сухбат)|(?:корманд|оператор)(?:ро)?\s+(?:ҷеғ|чег|даъват|пайваст|мехоҳам|лозим|даркор))(?![\p{L}])/iu;
const NO_CALL_COMPLAINT = /(?<![\p{L}])(?:мне\s+(?:так\s+и\s+)?не\s+(?:пере)?звонил(?:а|и)?|ба\s+ман\s+занг\s+назад(?:анд)?)(?![\p{L}])/iu;
const OWNER_QUESTION = /[?？]|(?<![\p{L}])(?:спросите|уточните|узнайте|сколько|когда|где|какой|какая|есть\s+ли|можно\s+ли|пурсед|фаҳмонед|чанд|кай|куҷо|оё)(?![\p{L}])/iu;
const BOOK = /(?<![\p{L}])(?:запишите|записаться|покажите|посмотреть|осмотр|показ|тамошо|дидан)(?![\p{L}])/iu;
const MOVE = /(?<![\p{L}])(?:перенесите|перенести|переносим|иваз\s+кунед|дигар\s+вақт)(?![\p{L}])/iu;
const CANCEL = /(?<![\p{L}])(?:отмените|отменить|отменяем|бекор\s+кунед)(?![\p{L}])/iu;
function exactStatedDate(text: string, at: string): boolean {
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) return false;
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dushanbe", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(instant)
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  const dates = [...text.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*(?:(?:в|соати|дар)\s*)?(\d{1,2})[:.](\d{2})(?!\d)/gu)];
  return dates.length === 1 && Number(dates[0][1]) === values.day && Number(dates[0][2]) === values.month &&
    Number(dates[0][3]) === values.year && Number(dates[0][4]) === values.hour && Number(dates[0][5]) === values.minute && instant.getUTCSeconds() === 0;
}
/** A model can propose a command but cannot approve it. Until the delivery-
 * backed proposal/confirmation adapter is installed, date-changing actions
 * accept only a single fully stated date/time from this authenticated IN.
 * Ambiguous/relative dates stay clarification, never a guessed booking. */
export function currentInputAuthorizesCustomerCommand(text: string, command: CustomerMutationCommand): boolean {
  const own = stripUntrusted(text, ["document", "video", "crm_note"]).normalize("NFKC").trim();
  // This command only appends the genuine current input to the caller's own
  // vacancy application. It neither accepts a model payload nor authorizes a
  // call/interview. Job context and current opening are checked under DB locks.
  if (command.name === "save_job_application") return own.length <= 8000;
  if (!own || own.length > 8000 || REPORTED_OR_NEGATED.test(own)) return false;
  if ((command.name === "book_showing" || command.name === "reschedule_showing" || command.name === "cancel_showing") &&
      (/[?？]/u.test(own) || /(?<![\p{L}])(?:как|можно|возможно|чи\s+хел|мешавад)(?![\p{L}])/iu.test(own))) return false;
  switch (command.name) {
    case "request_handover": return !HANDOVER_NOT_REQUEST.test(own) && (HANDOVER_REQUEST.test(own) || BARE_HANDOVER.test(own) || HANDOVER_TG.test(own) ||
      NO_CALL_COMPLAINT.test(own)) && command.args.topic === own.slice(0, 500);
    case "ask_owner": return OWNER_QUESTION.test(own) && command.args.question === own && own.length <= 1000;
    case "book_showing": return BOOK.test(own) && !CANCEL.test(own) && !MOVE.test(own) && exactStatedDate(own, command.args.at);
    case "reschedule_showing": return MOVE.test(own) && !CANCEL.test(own) && exactStatedDate(own, command.args.at);
    case "cancel_showing": return CANCEL.test(own) && !MOVE.test(own);
    case "save_contact": case "request_callback": return false; // existing dedicated slot/consent issuer
  }
}

/** Real normalized FINAL-IN only. This records a per-kind, per-command intent,
 * not a resource, receipt, Client link, provider send or write authority. */
export async function openAuthenticatedCustomerMutationIntent(input: AuthenticatedCustomerInput,
  ticket: CustomerPropertyAdmission, rawCommand: CustomerMutationCommand): Promise<"opened" | "denied" | "stale" | "unavailable"> {
  const command = customerMutationCommandSchema.safeParse(rawCommand), evidence = inspectAuthenticatedCustomerInput(input);
  if (!command.success || !evidence || evidence.assurance !== "protected_namespace" || evidence.provenance !== "meta_signature" ||
      !currentInputAuthorizesCustomerCommand(evidence.inputText, command.data)) return "denied";
  const kind = customerMutationKind(command.data);
  try {
    return await prisma.$transaction(async tx => {
      const accepted = await loadAcceptedCustomerState(ticket, tx);
      if (!accepted || !authenticatedInputMatchesFence(input, accepted.fence) ||
          evidence.channel !== accepted.fence.endpoint.channel || evidence.peer !== accepted.fence.endpoint.peerId ||
          evidence.protectedMetaEndpointScopeId !== accepted.fence.endpoint.endpointScopeId ||
          evidence.protectedMetaAccountId !== accepted.fence.endpoint.accountId || !customerActionCapability(accepted, kind)) return "denied";
      const fence = await assertCustomerFence(tx, accepted.fence, "local_write");
      if (fence.status !== "current") return fence.status;
      if (command.data.name === "save_job_application" &&
          (fence.snapshot.publicState.topic !== "job" || !fence.snapshot.publicState.jobPositionKey)) return "denied";
      const changed = await transitionCustomerState(tx, accepted.fence, { type: "intent", kind, change: "request",
        evidenceRefs: [ticket.eventKey], commandDigest: customerMutationDigest(command.data) });
      return changed.status === "applied" || changed.status === "same_event" ? "opened" : changed.status;
    }, { maxWait: 3000, timeout: 5000 });
  } catch { return "unavailable"; }
}
