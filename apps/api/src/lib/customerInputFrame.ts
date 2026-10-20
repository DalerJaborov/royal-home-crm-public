/** Authentication of an HTTP envelope does not classify its individual frames.
 * Flags are produced by the existing transport/history classifier, not accepted
 * from a model or customer tool. No identity or write grant is returned here. */
export function isFinalCustomerInputFrame(frame: {
  isEcho?: boolean; bareTemplateEcho: boolean; ownAccountSender: boolean; fromStaff?: boolean;
  referralOnly?: boolean; knownOutgoingMid: boolean; inFlightBotEcho: boolean;
  kind: "message" | "postback" | "status" | "read" | "typing" | "staff";
}): boolean {
  return (frame.kind === "message" || frame.kind === "postback") && !frame.isEcho && !frame.bareTemplateEcho &&
    !frame.ownAccountSender && !frame.fromStaff && !frame.referralOnly && !frame.knownOutgoingMid && !frame.inFlightBotEcho;
}
