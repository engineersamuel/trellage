import { Option } from "effect";
import { Runtime } from "foldkit";
import type { Message } from "./message";
import type { Model } from "./model";

/** The first render, and the render after settings load, draw the whole page (navbar, panel, theme) at once.
 *  Every other slow phase is reported, chat Messages included. */
const isWholePageDraw = (context: Runtime.SlowContext<Model, Message>): boolean =>
  (context._tag === "View" || context._tag === "Patch") &&
  Option.match(context.message, { onNone: () => true, onSome: ({ _tag }) => _tag === "GotSettingsMessage" });

export const onSlow = (context: Runtime.SlowContext<Model, Message>): void => {
  if (!isWholePageDraw(context)) Runtime.defaultSlowCallback(context);
};
