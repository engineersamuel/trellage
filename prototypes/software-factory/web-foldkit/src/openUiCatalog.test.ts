// The coordinator checks its cards against shared/openui-chat-library.json (CI does not install web-foldkit).
// That copy must stay the catalog agent-interface draws.
import { expect, test } from "vitest";
import installed from "../node_modules/@plana-solutions/agent-interface/dist/client/genui/openui-chat-library.json";
import copy from "../../shared/openui-chat-library.json";

test("shared/openui-chat-library.json matches the installed agent-interface catalog", () => {
  expect(copy).toEqual(installed);
});
