import { useEffect } from "react";

// Locks document scrolling while a full-screen sheet/modal is mounted.
// The lock must go on <html> — the viewport takes its overflow from the root
// element, so hiding overflow on <body> alone doesn't stop touch scrolling on
// mobile. The effect cleanup restores the previous values on unmount, so a
// sheet can never leave the page wedged. Locks nest safely for the app's use:
// sheets here are mutually exclusive, and a stacked sheet unmounting restores
// the "" it saw on mount.
export function useLockBodyScroll() {
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prevH = html.style.overflow, prevB = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => { html.style.overflow = prevH; body.style.overflow = prevB; };
  }, []);
}
