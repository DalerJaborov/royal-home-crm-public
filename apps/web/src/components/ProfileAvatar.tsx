import { useState, type ReactNode } from "react";

/** A missing uploaded file must leave a usable profile trigger, not a broken image. */
export function ProfileAvatar({ src, fallback, className }: { src?: string | null; fallback: ReactNode; className: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc
    ? <img src={src} alt="" className={className} onError={() => setFailedSrc(src)} />
    : <>{fallback}</>;
}
