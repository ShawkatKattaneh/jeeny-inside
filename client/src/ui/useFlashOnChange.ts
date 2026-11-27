import { useEffect, useRef, useState } from "react";

/**
 * Returns a class that plays a single, short tint (`.status-flash-a` / `-b` in styles.css) each time
 * `value` changes after the first render, so a live status change is visible without reading the text.
 * Nothing plays on first render, and the global reduced-motion rule removes the animation entirely.
 * The status text itself is never changed by this hook.
 */
export function useFlashOnChange(value: string | null | undefined): string {
  const last = useRef(value);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    setCount((n) => n + 1);
  }, [value]);
  if (count === 0) return "";
  return count % 2 === 1 ? "status-flash-a" : "status-flash-b";
}
