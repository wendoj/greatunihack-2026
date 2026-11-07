const Item = ({ sw, children }: { sw: React.ReactNode; children: React.ReactNode }) => (
  <li className="flex items-center gap-2.5">
    <span className="flex w-7 shrink-0 justify-center">{sw}</span>
    <span>{children}</span>
  </li>
);

const Line = ({ color, dash, w = 2 }: { color: string; dash?: string; w?: number }) => (
  <svg width="28" height="8" aria-hidden>
    <line x1="1" y1="4" x2="27" y2="4" stroke={color} strokeWidth={w} strokeDasharray={dash} strokeLinecap="round" />
  </svg>
);

const Ring = ({ color, dash, slash }: { color: string; dash?: string; slash?: boolean }) => (
  <svg width="18" height="18" aria-hidden>
    <circle cx="9" cy="9" r="4.5" fill="#525252" />
    <circle cx="9" cy="9" r="7.5" fill="none" stroke={color} strokeWidth="1.75" strokeDasharray={dash} />
    {slash && <line x1="3.5" y1="14.5" x2="14.5" y2="3.5" stroke={color} strokeWidth="1.75" />}
  </svg>
);

const KEYS: [string, string][] = [
  ["␣", "start"],
  ["B", "blackout"],
  ["R", "reset"],
  ["1–6", "agent"],
  ["T", "truth"],
  ["0", "base"],
  ["V", "reveal"],
];

const Divider = () => <li className="my-1.5 h-px bg-border" aria-hidden />;

export function Legend() {
  return (
    <aside className="flex w-40 shrink-0 flex-col justify-between overflow-y-auto py-1 text-[11.5px] text-foreground/60">
      <ul className="flex flex-col gap-1.5">
        <li className="mb-1 flex flex-col gap-1">
          <div className="h-1.5 rounded-full bg-gradient-to-r from-amber-400/10 via-amber-400/70 to-red-500" />
          <div className="flex justify-between font-mono text-[10px] text-foreground/40 uppercase">
            <span>unlikely</span>
            <span>likely</span>
          </div>
        </li>
        <Item
          sw={
            <svg width="18" height="14" aria-hidden>
              <line x1="3" y1="12" x2="15" y2="2" stroke="rgba(186,230,253,0.6)" strokeWidth="1.5" />
            </svg>
          }
        >
          searched
        </Item>
        <Item
          sw={
            <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden>
              <path d="M8 17 L3.5 8 A5 5 0 1 1 12.5 8 Z" fill="#fde68a" stroke="#000" />
              <text x="8" y="9.5" fontSize="7" fontWeight="700" textAnchor="middle" fill="#000">?</text>
            </svg>
          }
        >
          last seen
        </Item>
        <Item
          sw={
            <svg width="18" height="18" aria-hidden>
              <path d="M6 2h6v4h4v6h-4v4H6v-4H2V6h4z" fill="#ef4444" stroke="#fff" strokeWidth="1" />
            </svg>
          }
        >
          hiker
        </Item>
        <Divider />
        <Item sw={<Line color="#22c55e" />}>radio link</Item>
        <Item sw={<Line color="#ef4444" dash="5 4" w={1.5} />}>ridge blocks</Item>
        <Item sw={<Line color="#6b7280" dash="1.5 4" w={1.5} />}>storm drops</Item>
        <Item sw={<Line color="#a3a3a3" dash="3 4" w={1} />}>heading</Item>
        <Divider />
        <Item
          sw={
            <svg width="18" height="18" aria-hidden>
              <rect x="2" y="2" width="14" height="14" rx="2" fill="#000" stroke="#f8fafc" strokeWidth="1.75" />
              <path d="M4.5 13 L9 5 L13.5 13 Z" fill="#f8fafc" />
            </svg>
          }
        >
          base
        </Item>
        <Item sw={<Ring color="#f59e0b" />}>messenger</Item>
        <Item sw={<Ring color="#a855f7" />}>relay</Item>
        <Item sw={<Ring color="#cbd5e1" slash />}>hold</Item>
        <Item sw={<Ring color="#6b7280" dash="2 2" />}>radio off</Item>
      </ul>

      <ul className="mt-4 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[10px] uppercase">
        {KEYS.map(([k, v]) => (
          <li key={k} className="contents">
            <kbd className="min-w-6 rounded border border-hairline bg-white/[0.03] px-1 text-center text-foreground/70">
              {k}
            </kbd>
            <span className="text-foreground/40">{v}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
