// Visual-viewport height hook (Task 27): where 100dvh does not track the
// software keyboard (iOS-style overlay IME), the page must shrink to the
// visual viewport so the input dock is never pushed under it. Returns
// undefined while the visual viewport covers the layout viewport — the
// CSS block-size:100dvh path then handles everything (incl. Android's
// interactive-widget=resizes-content) and no style is applied.
import { useEffect, useState } from "react";

export const useVisualViewportHeight = (): number | undefined => {
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const vv = window.visualViewport;
    if (vv === null || vv === undefined) return;
    const update = (): void => {
      // occluded = layout viewport not covered by the visual one. Only a
      // real shrink counts — pinch-zoom offsetTop is ignored on purpose.
      const occluded = vv.height + vv.offsetTop < window.innerHeight - 1;
      setHeight(occluded ? vv.height : undefined);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return height;
};
