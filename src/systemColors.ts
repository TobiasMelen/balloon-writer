// Colours for the caret and selection: the page's CSS if it sets them on the
// text input, otherwise the OS's own via CSS system colour keywords.
// - selection: the input's ::selection background, else `Highlight` (with its
//   alpha);
// - caret: the input's caret-color, else its accent-color, else `AccentColor`
//   (there's no caret keyword).
// The browser resolves a colour when it's set on an element, so reading the
// computed style gives the real value.
import { useEffect, useState } from "react";
import * as THREE from "three";

export type SystemColor = { color: THREE.Color; alpha: number };
export type SystemColors = { highlight: SystemColor; accent: SystemColor };

const FALLBACK_BLUE = "#1f6bff";

/** "rgb(r, g, b)" / "rgba(r, g, b, a)" as a colour and alpha; null if it
 *  isn't a colour (e.g. "auto"). */
function parse(computed: string): SystemColor | null {
  if (!computed.startsWith("rgb")) return null;
  const [r = 0, g = 0, b = 0, a = 1] = computed.match(/[\d.]+/g)?.map(Number) ?? [];
  return { color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), alpha: a };
}

/** A system colour keyword, resolved (or the fallback where unsupported). */
function keyword(name: string): SystemColor {
  const probe = document.createElement("div");
  probe.style.color = CSS.supports("color", name) ? name : FALLBACK_BLUE;
  probe.style.display = "none";
  document.body.append(probe);
  const color = parse(getComputedStyle(probe).color)!;
  probe.remove();
  return color;
}

function read(input: HTMLElement | null): SystemColors {
  const style = input && getComputedStyle(input);
  const selection = input && parse(getComputedStyle(input, "::selection").backgroundColor);
  // An unset caret-color ("auto") reads back as the text colour.
  const caret = style && style.caretColor !== style.color ? parse(style.caretColor) : null;
  const accent = style && parse(style.accentColor);
  // Transparent counts as unset (e.g. a hidden input's native caret).
  const visible = (c: SystemColor | null) => (c && c.alpha > 0 ? c : null);
  return {
    highlight: visible(selection) ?? keyword("Highlight"),
    accent: visible(caret) ?? visible(accent) ?? keyword("AccentColor"),
  };
}

/** The caret and selection colours for `input`, read again when the window
 *  regains focus (OS settings may have changed), the colour scheme flips, or
 *  the page's styles change (e.g. a stylesheet hot-reloads). */
export function useSystemColors(input: HTMLElement | null) {
  const [colors, setColors] = useState(() => read(input));
  useEffect(() => {
    const update = () => setColors(read(input));
    update();
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const styles = new MutationObserver(update);
    styles.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    window.addEventListener("focus", update);
    scheme.addEventListener("change", update);
    return () => {
      styles.disconnect();
      window.removeEventListener("focus", update);
      scheme.removeEventListener("change", update);
    };
  }, [input]);
  return colors;
}
