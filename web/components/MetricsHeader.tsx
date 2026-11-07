export function MetricsHeader({ probSearched }: { probSearched: number }) {
  return (
    <header className="flex items-baseline gap-3 border-b border-border px-5 py-3">
      <span className="font-pixel text-[40px] leading-none text-foreground tabular-nums">
        {(probSearched * 100).toFixed(1)}
        <span className="text-2xl text-foreground/70">%</span>
      </span>
      <span className="eyebrow">Probability searched</span>
    </header>
  );
}
