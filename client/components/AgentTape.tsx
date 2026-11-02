'use client';
import { useEffect, useRef } from 'react';
import type { LogRow } from '@/lib/api';

export default function AgentTape({ logs, running }: { logs: LogRow[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <aside className="tape-col" aria-label="Agent activity">
      <div className="tape-head">
        <h2>Agent activity</h2>
        {running && <span className="live" role="status">Working…</span>}
      </div>
      <div className="tape" ref={ref}>
        {logs.length === 0 && <p className="tape-empty">Nothing yet. Run the agent and each step it takes will print here.</p>}
        {logs.map((l) => (
          <div key={l.id} className={`entry ${l.kind}`}>
            {(l.kind === 'info' || l.kind === 'thought' || l.kind === 'done') && (
              <time>{new Date(l.ts).toLocaleTimeString()}</time>
            )}
            {l.text}
          </div>
        ))}
      </div>
    </aside>
  );
}
