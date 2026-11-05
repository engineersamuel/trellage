// The factory stream (shared, plain DOM) shows coordinator answers written in OpenUI Lang as rendered cards.
// agent-interface renders OpenUI only inside its own chat model, so the stream uses the OpenUI React renderer.
// Its CSS classes are the same ones agent-interface's stylesheet already loads.
import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { setOpenUiRenderer } from "../../shared/protos";

setOpenUiRenderer((el, program, onAction) => {
  const root = createRoot(el);
  root.render(
    createElement(ThemeProvider, { mode: "dark" }, createElement(Renderer, { response: program, library: openuiChatLibrary, isStreaming: false, onAction })),
  );
  return () => root.unmount();
});
