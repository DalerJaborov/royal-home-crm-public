import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const ISSUER = "Royal Home CRM";

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function makeTotp(label: string, secret: string) {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

// Data-URL QR-код, который сканирует Google Authenticator/Authy — генерируется
// целиком на сервере, секрет никуда во внешний сервис не уходит.
export async function generateTotpQrCode(label: string, secret: string): Promise<string> {
  const totp = makeTotp(label, secret);
  return QRCode.toDataURL(totp.toString());
}

// window: 1 — допускает код с предыдущего/следующего 30-секундного шага,
// компенсирует небольшое расхождение часов телефона и сервера.
export function verifyTotpCode(label: string, secret: string, code: string): boolean {
  const totp = makeTotp(label, secret);
  const delta = totp.validate({ token: code.trim(), window: 1 });
  return delta !== null;
}
