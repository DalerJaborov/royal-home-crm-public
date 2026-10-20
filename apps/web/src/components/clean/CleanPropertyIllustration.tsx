import { useState } from "react";
import { House } from "lucide-react";

/** Decorative empty-state artwork; never presented as a photograph of a listing. */
export function CleanPropertyIllustration({ size = 96 }: { size?: number }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <House width={size / 2} height={size / 2} aria-hidden="true" className="shrink-0 text-gray-500" />
    : <img src="/illustrations/property-empty.png" alt="" aria-hidden="true" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className="shrink-0 object-contain" />;
}
