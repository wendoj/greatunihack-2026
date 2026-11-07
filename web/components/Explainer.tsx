"use client";

import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const KEY = "ridgeline.explainer.seen";

export function Explainer() {
  const [open, setOpen] = useState(false);

  // Open automatically on the first visit only.
  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(KEY) === "1";
    } catch {}
    if (!seen) {
      const t = setTimeout(() => setOpen(true), 400);
      return () => clearTimeout(t);
    }
  }, []);

  const change = (o: boolean) => {
    setOpen(o);
    if (!o)
      try {
        localStorage.setItem(KEY, "1");
      } catch {}
  };

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger className="eyebrow hover:text-foreground" aria-label="How to read this">
        How to read this
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 gap-4 rounded-lg border border-hairline bg-popover p-5 ring-0"
      >
        <ul className="flex flex-col gap-3 text-[13px] leading-snug text-foreground/80">
          <li>
            <b className="font-medium text-amber-300">The heat</b> shows where the hiker probably is. It cools as
            ground is searched. The big number at the top is the team&apos;s shared goal.
          </li>
          <li>
            <b className="font-medium text-foreground">Each circle is an agent choosing its own next move.</b> Its
            reason is in the right-hand panel. Nobody gives it orders.
          </li>
          <li>
            <b className="font-medium text-emerald-400">Green lines</b> are working radio links.{" "}
            <b className="font-medium text-red-400">Red dashed lines</b> are links the ridge blocks.
          </li>
          <li>
            <b className="font-medium text-foreground">Pick an agent</b> to see only what it knows. Cut its radio and
            watch its map fall behind, then catch up when it reconnects.
          </li>
        </ul>
        <button onClick={() => change(false)} className="btn-brand h-8 self-end px-4">
          Got it
        </button>
      </PopoverContent>
    </Popover>
  );
}
