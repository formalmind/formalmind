"use client";

/**
 * The notification bell, ported from Async Swap (`@asyncswap/ui` NotificationCenter, header mode).
 * Unread notices sit in the dropdown; "View all" opens the full list and the read history.
 * The store is lib/notifications.ts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Bell, Check, Copy, X } from "lucide-react";
import {
  dismissNotification,
  markNotificationRead,
  useNotifications,
} from "@/lib/notifications";

function relativeTime(fromMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - fromMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function NotificationCenter() {
  const all = useNotifications();
  const unread = useMemo(() => all.filter((n) => !n.read), [all]);
  const readHistory = useMemo(() => all.filter((n) => n.read), [all]);
  const [now, setNow] = useState(() => Date.now());
  const [headerOpen, setHeaderOpen] = useState(false);
  const [headerViewAll, setHeaderViewAll] = useState(false);
  const [headerShowReadHistory, setHeaderShowReadHistory] = useState(false);
  const latestNotificationRef = useRef<{ id: string | number; createdAt: number } | null>(null);

  // Tick only while there are notifications (relative time + expiry).
  useEffect(() => {
    if (unread.length === 0 && !headerOpen && !headerViewAll) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [unread.length, headerOpen, headerViewAll]);

  const active = useMemo(
    () => unread.filter((n) => now - n.createdAt < n.duration),
    [unread, now],
  );

  // Keep the bell history out of the way when a new toast is shown. Changes
  // from reading or dismissing existing entries do not close the panel.
  useEffect(() => {
    const latest = all[0];
    const previous = latestNotificationRef.current;
    if (!latest) {
      latestNotificationRef.current = null;
      return;
    }

    const isNewOrUpdated = previous !== null && latest.createdAt >= previous.createdAt &&
      (latest.id !== previous.id || latest.createdAt > previous.createdAt);
    if (headerOpen && isNewOrUpdated && active.some((notification) => notification.id === latest.id)) {
      setHeaderOpen(false);
      setHeaderViewAll(false);
      setHeaderShowReadHistory(false);
    }
    latestNotificationRef.current = { id: latest.id, createdAt: latest.createdAt };
  }, [active, all, headerOpen]);

  // The panel is drawn at the page's top level, under the bell, so nothing on the page (the swarm chat) covers it.
  const bellRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!headerOpen) return;
    const place = () => {
      const r = bellRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [headerOpen]);

  return (
    <div ref={bellRef} data-fm-bell className="relative shrink-0">
      <button
        type="button"
        aria-label={
          unread.length ? `Notifications, ${unread.length} unread` : "Notifications"
        }
        aria-expanded={headerOpen}
        onClick={() => {
          if (headerOpen) {
            // Closing the dropdown files what was seen under history.
            for (const n of unread) markNotificationRead(n.id);
            setHeaderViewAll(false);
            setHeaderShowReadHistory(false);
          }
          setHeaderOpen((open) => !open);
        }}
        className="relative inline-flex size-8 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Swings on hover; rings once when a new notification arrives (keyed on the count, so it replays). */}
        <Bell key={unread.length} aria-hidden="true" className={`fm-bell size-3.5 ${unread.length ? "fm-bell-ring" : ""}`} />
        {unread.length > 0 && (
          <span className="fm-badge absolute -right-0.5 -top-0.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
            {unread.length > 99 ? "99" : unread.length}
          </span>
        )}
      </button>
      {headerOpen && anchor && createPortal(
        <div
          role="dialog"
          aria-label="Notifications"
          className="fixed z-[9999999] w-[min(22rem,calc(100vw-1.5rem))]"
          style={{ top: anchor.top, right: anchor.right }}
        >
          <div className="space-y-2 rounded-3xl bg-muted p-3 shadow-md">
            {all.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No notifications</p>
            ) : (
              <div className={headerViewAll ? "max-h-[min(70vh,34rem)] space-y-2 overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden" : "space-y-2"}>
                {(headerShowReadHistory ? readHistory : headerViewAll ? unread : unread.slice(0, 3)).map((n) => (
              <div
                key={n.id}
                className="relative min-w-0 rounded-xl border border-border bg-background px-4 py-2 pr-11 shadow-sm"
              >
                <button
                  type="button"
                  aria-label={`Dismiss ${n.title}`}
                  title="Dismiss notification"
                  className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => dismissNotification(n.id)}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{n.title}</p>
                  {n.read && <span className="shrink-0 text-[10px] text-muted-foreground">Read</span>}
                </div>
                <div className={`min-w-0 select-text break-words text-xs font-medium text-muted-foreground ${n.variant === "error" ? "max-h-40 overflow-y-auto whitespace-pre-wrap" : ""}`}>
                  <span>{relativeTime(n.createdAt, now)}</span>
                  {n.description != null && <> {n.description}</>}
                </div>
                {n.action || n.variant === "error" ? (
                  <div className="mt-2 flex items-center gap-1.5">
                    {n.action && (
                      <button
                        type="button"
                        className="btn-dark h-7 px-3 text-xs"
                        onClick={() => window.dispatchEvent(new Event(n.action!.event))}
                      >
                        {n.action.label}
                      </button>
                    )}
                    {n.variant === "error" || n.copy ? <CopyNotice text={n.copy ?? [n.title, n.description].filter(Boolean).join(": ")} /> : null}
                  </div>
                ) : null}
              </div>
                ))}
                {(headerShowReadHistory ? readHistory : unread).length === 0 && (
                  <p className="px-2 py-3 text-sm text-muted-foreground">{headerShowReadHistory ? "No read notifications" : "No unread notifications"}</p>
                )}
              </div>
            )}
            {all.length > 0 && (
              <div className="flex min-w-0 items-center justify-between gap-2 whitespace-nowrap px-1 pt-1 text-sm font-medium text-muted-foreground">
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-xs text-background">
                    {unread.length}
                  </span>
                </div>
                {all.length > 0 && !headerViewAll && (
                  <button
                    type="button"
                    aria-expanded={headerViewAll}
                    onClick={() => {
                      setHeaderViewAll(true);
                      setHeaderShowReadHistory(false);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    View all
                    <ArrowUpRight aria-hidden="true" className="size-4" />
                  </button>
                )}
                {headerViewAll && (
                  <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                    <button
                      type="button"
                      aria-pressed={!headerShowReadHistory}
                      onClick={() => setHeaderShowReadHistory(false)}
                      className={`whitespace-nowrap rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${headerShowReadHistory ? "font-medium text-muted-foreground hover:text-foreground" : "font-semibold text-foreground"}`}
                    >
                      Unread
                    </button>
                    <button
                      type="button"
                      aria-pressed={headerShowReadHistory}
                      onClick={() => setHeaderShowReadHistory(true)}
                      className={`whitespace-nowrap rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${headerShowReadHistory ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground"}`}
                    >
                      history
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderViewAll(false);
                        setHeaderShowReadHistory(false);
                      }}
                      className="whitespace-nowrap rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      show less
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Copies a notice (an error and its details) to paste elsewhere. */
function CopyNotice({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-muted px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}
