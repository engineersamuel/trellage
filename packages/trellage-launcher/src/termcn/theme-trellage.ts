import type { Theme } from "./types.ts";

/**
 * Trellage's terminal theme. Every color is an Ink base 16-color *name*
 * rather than a hex value, unlike the termcn default theme.
 *
 * The launcher already committed to the base palette because it degrades
 * predictably on terminals without truecolor, and because a named color
 * follows the user's own terminal palette instead of overriding it. Keeping
 * that commitment here means adopting termcn components changes which name a
 * given role resolves to, never how many colors the launcher needs.
 *
 * `background` and `foreground` exist only to satisfy the `Theme` contract.
 * No Trellage surface reads them; the terminal's own background and text
 * color are left alone on purpose. A component that paints either one should
 * not be adopted without revisiting this.
 */
export const trellageTheme: Theme = {
  name: "trellage",
  colors: {
    primary: "cyan",
    primaryForeground: "black",
    secondary: "gray",
    secondaryForeground: "black",
    accent: "magenta",
    accentForeground: "black",
    success: "green",
    successForeground: "black",
    warning: "yellow",
    warningForeground: "black",
    error: "red",
    errorForeground: "black",
    info: "blue",
    infoForeground: "white",
    background: "black",
    foreground: "white",
    muted: "gray",
    mutedForeground: "gray",
    border: "gray",
    focusRing: "cyan",
    selection: "green",
    selectionForeground: "black",
  },
  spacing: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 },
  typography: { bold: true, sm: "dim", base: "", lg: "bold", xl: "bold" },
  border: { style: "round", color: "gray", focusColor: "cyan" },
};
