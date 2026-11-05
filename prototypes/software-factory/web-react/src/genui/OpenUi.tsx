// OpenUI in the CopilotKit UI: the one place that imports @openuidev. Two uses, one look:
//   - `OpenUiCard`: the chat's render_ui tool (agent-designed UI);
//   - `renderOpenUiInto`: the shared factory stream and canvas (plain DOM hosts, via setOpenUiRenderer).
// Both share the theme mapped from the factory palette and the same button actions.
import { Renderer } from "@openuidev/react-lang"
import { ThemeProvider } from "@openuidev/react-ui"
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib"
import "@openuidev/react-ui/components.css"
import { createRoot } from "react-dom/client"
import type { OpenUiAction } from "../../../shared/protos/core"
import type { Palette as PaletteSchema } from "../../../shared/schemas"
import { useApp } from "../state/store"

type Palette = typeof PaletteSchema.Type

/** Factory palette → OpenUI theme keys, so agent cards follow the active theme like the rest of the app. */
export const openUiTheme = (p: Palette) => ({
  background: p.bg,
  foreground: p.surface,
  popoverBackground: p.surface,
  sunk: p.bg,
  elevated: p.surface,
  textNeutralPrimary: p.text,
  textNeutralSecondary: p.muted,
  textNeutralLink: p.accent,
  textBrand: p.accent,
  textAccentPrimary: p.accent,
  interactiveAccentDefault: p.accent,
  interactiveAccentHover: p.accent,
  interactiveAccentPressed: p.accent,
})

const usePalette = (): Palette | undefined => useApp((s) => (s.settings ? s.settings.settings.themes[s.settings.settings.theme] : undefined))

type Props = { program: string; streaming: boolean; onAction: (a: OpenUiAction) => void }

/** One OpenUI program, themed from the factory palette. */
export function OpenUiCard({ program, streaming, onAction }: Props) {
  const palette = usePalette()
  return (
    <ThemeProvider mode="dark" {...(palette ? { darkTheme: openUiTheme(palette) } : {})}>
      <Renderer response={program} library={openuiChatLibrary} isStreaming={streaming} onAction={(e) => onAction(e as OpenUiAction)} />
    </ThemeProvider>
  )
}

/** Mount a card into a plain-DOM host (shared/protos). Returns the unmount. */
export const renderOpenUiInto = (el: HTMLElement, program: string, onAction: (a: OpenUiAction) => void): (() => void) => {
  const root = createRoot(el)
  root.render(<OpenUiCard program={program} streaming={false} onAction={onAction} />)
  return () => root.unmount()
}
