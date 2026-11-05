import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { describe, expect, test } from "vitest";
import type { Worker } from "../domain";
import { FetchBacklog, FetchWorkers, SendToWorker, StopWorker } from "./command";
import { Message, OutMessage } from "./message";
import { WorkersAsyncData } from "./model";
import { toBacklogLines } from "./log";
import { focus, init, update } from "./update";

const coordinator: Worker = { id: "coordinator", name: "Factory desk", role: "coordinator", status: "idle", auth: "native", model: "gpt", pid: 1, rssKb: 2048 };
const namer: Worker = { ...coordinator, id: "namer", name: "namer", role: "worker", status: "running" };

const event = (seq: number, type: string, workerId = "coordinator", data: unknown = { content: `line ${seq}` }) => ({
  seq,
  workerId,
  type,
  agentId: null,
  timestamp: "0",
  data,
});

const loaded = modifyFields(init("coordinator").model, { workers: () => WorkersAsyncData.Success({ data: [coordinator, namer] }) });

describe("loading", () => {
  test("init loads the workers and the selected worker's backlog", () => {
    const { model: initial, commands } = init("coordinator");
    expect(initial.workers._tag).toBe("Loading");
    expect(commands?.map(({ name }) => name)).toEqual(["FetchWorkers", "FetchBacklog"]);
  });

  test("a failed worker fetch is shown as a Failure, not dropped", () => {
    story(
      update,
      given(init("coordinator").model),
      message(Message.FailedFetchWorkers({ error: "HTTP 500" })),
      model((current) => expect(current.workers).toEqual(AsyncData.fail("HTTP 500"))),
    );
  });

  test("a failed refresh keeps the last worker list as Stale", () => {
    story(
      update,
      given(loaded),
      message(Message.FailedFetchWorkers({ error: "offline" })),
      model((current) => expect(current.workers._tag).toBe("Stale")),
    );
  });

  test("a feed gap refreshes the workers and the backlog", () => {
    story(
      update,
      given(loaded),
      message(Message.ReceivedFeedGap()),
      Command.expectExact(FetchWorkers, FetchBacklog),
      model((current) => expect(current.workers._tag).toBe("Refreshing")),
      Command.resolveAll(
        [FetchWorkers, Message.SucceededFetchWorkers({ workers: [coordinator] })],
        [FetchBacklog, Message.SucceededFetchBacklog({ workerId: "coordinator", lines: toBacklogLines([]) })],
      ),
      model((current) => expect(AsyncData.getData(current.workers)).toEqual(Option.some([coordinator]))),
    );
  });
});

describe("the log", () => {
  test("the backlog merges with live events by seq, so events during the fetch are kept", () => {
    story(
      update,
      given(loaded),
      message(Message.ReceivedWorkerEvent({ event: event(5, "assistant.message") })),
      message(Message.SucceededFetchBacklog({ workerId: "coordinator", lines: toBacklogLines([event(3, "user.message"), event(5, "assistant.message")]) })),
      model((current) => expect(current.logLines.map(({ seq }) => seq)).toEqual([3, 5])),
    );
  });

  test("a seq repeated inside one backlog is logged once", () => {
    story(
      update,
      given(loaded),
      message(Message.SucceededFetchBacklog({ workerId: "coordinator", lines: toBacklogLines([event(4, "user.message"), event(4, "user.message")]) })),
      model((current) => expect(current.logLines.map(({ seq }) => seq)).toEqual([4])),
    );
  });

  test("a backlog for a worker that is no longer selected is ignored", () => {
    story(
      update,
      given(loaded),
      message(Message.SucceededFetchBacklog({ workerId: "namer", lines: toBacklogLines([event(1, "user.message", "namer")]) })),
      model((current) => expect(current.logLines).toEqual([])),
    );
  });

  test("events of other workers and hidden event kinds are not logged", () => {
    story(
      update,
      given(loaded),
      message(Message.ReceivedWorkerEvent({ event: event(1, "user.message", "namer") })),
      message(Message.ReceivedWorkerEvent({ event: event(2, "assistant.streaming_delta") })),
      model((current) => expect(current.logLines).toEqual([])),
    );
  });

  test("focus resets the log and loads the new worker's backlog", () => {
    const withLine = update(loaded, Message.ReceivedWorkerEvent({ event: event(1, "user.message") })).model;
    const { model: focused, commands } = focus("namer")(withLine);
    expect(focused.selectedWorkerId).toBe("namer");
    expect(focused.logLines).toEqual([]);
    expect(commands?.map(({ name }) => name)).toEqual(["FetchBacklog"]);
    expect(focus("namer")(focused).commands).toBeUndefined();
  });
});

describe("workers", () => {
  test("clicking a worker asks the parent to focus it", () => {
    story(update, given(loaded), message(Message.ClickedWorker({ workerId: "namer" })), expectOutMessage(OutMessage.SelectedWorker({ workerId: "namer" })));
  });

  test("worker updates upsert and stops remove", () => {
    story(
      update,
      given(loaded),
      message(Message.ReceivedWorkerUpdate({ worker: { ...namer, status: "idle" } })),
      message(Message.ReceivedWorkerStopped({ workerId: "coordinator" })),
      model((current) => expect(AsyncData.getData(current.workers)).toEqual(Option.some([{ ...namer, status: "idle" }]))),
    );
  });

  test("a failed stop is shown", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedStop({ workerId: "namer" })),
      Command.expectExact(StopWorker),
      Command.resolve(StopWorker, Message.FailedStopWorker({ error: "HTTP 404" })),
      model((current) => expect(current.maybeError).toEqual(Option.some("Stop failed: HTTP 404"))),
    );
  });
});

describe("sending a message", () => {
  test("the draft is cleared only after the worker accepted it", () => {
    story(
      update,
      given(loaded),
      message(Message.UpdatedMessageDraft({ value: "hello" })),
      message(Message.SubmittedMessageDraft()),
      model((current) => expect(current.messageDraft).toBe("hello")),
      Command.expectExact(SendToWorker),
      Command.resolve(SendToWorker, Message.SucceededSendToWorker({ prompt: "hello" })),
      model((current) => expect(current.messageDraft).toBe("")),
      expectNoOutMessage(),
    );
  });

  test("a failed send keeps the draft and shows the error", () => {
    story(
      update,
      given(loaded),
      message(Message.UpdatedMessageDraft({ value: "hello" })),
      message(Message.SubmittedMessageDraft()),
      Command.resolve(SendToWorker, Message.FailedSendToWorker({ error: "HTTP 500" })),
      model((current) => {
        expect(current.messageDraft).toBe("hello");
        expect(current.maybeError).toEqual(Option.some("Send failed: HTTP 500"));
      }),
    );
  });

  test("an empty draft sends nothing", () => {
    story(update, given(loaded), message(Message.SubmittedMessageDraft()), Command.expectNone());
  });
});
