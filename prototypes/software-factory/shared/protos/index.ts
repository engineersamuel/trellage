// Registers the factory layouts: Org Canvas (2) and Inbox (3, the default). Hosts call startPrototypes() once and render the stage markup.
// The other four prototypes are in git history (commit 3986cf16).
import "./p2"
import "./p3"
export { currentProto, onProto, setOpenUiRenderer, startPrototypes } from "./core"
