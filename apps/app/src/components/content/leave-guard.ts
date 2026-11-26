"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ClickLike = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};
type AnchorLike = { href: string; target: string; hasAttribute(name: string): boolean };

/**
 * The in-app address a click on this link would navigate to, or null when the click leaves the
 * app (another site, a new tab, a download) or stays on this page. Only those clicks need the guard:
 * the others either keep the page or are covered by beforeunload.
 */
export function inAppDestination(event: ClickLike, anchor: AnchorLike, current: string): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current);
    to = new URL(anchor.href, from);
  } catch {
    return null;
  }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return `${to.pathname}${to.search}${to.hash}`;
}

/**
 * Asks before leaving a page with unsaved changes. beforeunload covers reloads and other sites;
 * Next's client-side navigation never fires it, so clicks on in-app links are caught here, in the
 * capture phase before Next's Link handles them, and held until the user confirms.
 */
export function useLeaveGuard(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const destination = inAppDestination(event, anchor, window.location.href);
      if (!destination) return;
      event.preventDefault();
      event.stopPropagation();
      setPending(destination);
    };
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault();
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [dirty]);

  return {
    /** Where the user tried to go, while the confirmation is open. */
    pending,
    stay: () => setPending(null),
    leave: () => {
      const to = pending;
      setPending(null);
      if (to) router.push(to);
    },
  };
}
