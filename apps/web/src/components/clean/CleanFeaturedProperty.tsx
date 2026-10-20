import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { CChip } from "./ui";
import { CleanPropertyIllustration } from "./CleanPropertyIllustration";

/** Missing or failed imagery becomes a compact factual property link, not a gray hero. */
export function CleanFeaturedProperty({ to, title, subtitle, photo, showings, featured }: {
  to: string; title: string; subtitle: string; photo?: string; showings?: number; featured: boolean;
}) {
  const [failedPhoto, setFailedPhoto] = useState<string>();
  const hasPhoto = !!photo && failedPhoto !== photo;
  if (!hasPhoto) return (
    <Link to={to} className="clean-hero clean-hero-empty grid content-center gap-3 rounded-[20px] bg-card p-6 text-ink no-underline" style={{ minHeight: 0 }}>
      <div className="flex items-center justify-between gap-3"><CChip tone="gray">{featured ? "Объект недели" : "Объект"}</CChip><ArrowUpRight size={20} aria-hidden="true" /></div>
      <div className="flex items-center gap-4"><CleanPropertyIllustration /><h2 className="m-0 text-[24px] font-semibold leading-tight">{title}</h2></div>
      <p className="m-0 text-[16px] text-gray-600">{subtitle}</p>
      <p className="m-0 text-[14px] text-gray-600">Фото пока недоступно{showings !== undefined ? ` · показов: ${showings}` : ""}</p>
    </Link>
  );
  return (
    <Link to={to} className="clean-hero clean-hero-photograph group relative block overflow-hidden rounded-[20px] bg-card text-ink no-underline shadow-sm">
      <div className="h-[240px] overflow-hidden"><img src={photo} alt="" loading="lazy" decoding="async" onError={() => setFailedPhoto(photo)} className="size-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" /></div>
      <div className="absolute left-4 top-3.5"><CChip tone="white">{featured ? "Объект недели" : "Объект"}</CChip></div>
      <div className="clean-property-caption flex items-end justify-between gap-3 p-6">
        <div className="min-w-0"><h2 className="m-0 text-[26px] font-semibold leading-tight">{title}</h2><p className="mb-0 mt-2 text-[16px]">{subtitle}</p></div>
        {showings !== undefined && <span className="rounded-xl bg-row-alt px-3 py-2 text-[14px]"><b className="block text-[18px]">{showings}</b>показов</span>}
      </div>
    </Link>
  );
}
