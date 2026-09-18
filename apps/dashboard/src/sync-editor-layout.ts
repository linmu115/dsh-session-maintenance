import { useLayoutEffect, useRef } from "react";
/** Keep actions inside the visible viewport even below headings or expanded details. */
export function useSyncEditorLayout<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const available = Math.max(160, window.innerHeight - element.getBoundingClientRect().top - 20);
      const value = `${available}px`;
      if (element.style.maxHeight !== value) element.style.maxHeight = value;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element.parentElement ?? element);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure); };
  });
  return ref;
}
