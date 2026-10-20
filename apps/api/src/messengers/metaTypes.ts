/** Provider credential/channel contracts; no provider or business imports. */
export type MetaChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK";
export interface MetaCredentials {
  appSecret?: string;
  verifyToken?: string;
  waToken?: string;
  waPhoneId?: string;
  igToken?: string;
  igAppSecret?: string;
  pageToken?: string;
  pageId?: string;
}
