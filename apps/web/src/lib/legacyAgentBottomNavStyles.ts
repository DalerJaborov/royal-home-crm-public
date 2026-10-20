/** Frozen legacy phone presentation; the canonical renderer owns all navigation behavior. */
export const legacyAgentBottomNavStyles = {
  tab: "relative h-full min-h-[49px] flex flex-col items-center justify-center gap-[3px] active:scale-90 transition-transform",
  icon: (active: boolean) => `w-[23px] h-[23px] transition-colors ${active ? "text-blue" : "text-gray-500"}`,
  label: (active: boolean) => `text-[13px] transition-colors ${active ? "text-blue font-bold" : "text-gray-500 font-semibold"}`,
  badge: "absolute -top-0.5 right-[-7px] min-w-[15px] h-[15px] px-1 rounded-badge bg-red text-on-danger text-[13px] font-bold flex items-center justify-center",
  nav: "md:hidden fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-line",
  fab: "w-[54px] h-[54px] rounded-full bg-blue text-on-accent shadow-accent-btn flex items-center justify-center active:scale-90 transition-transform relative",
};
