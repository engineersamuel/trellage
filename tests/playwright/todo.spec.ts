import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Task = {
  id: string;
};

type TaskPage = {
  tasks: Task[];
  nextCursor: string | null;
};

async function clearTasks(request: APIRequestContext): Promise<void> {
  const taskIds: string[] = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams();
    if (cursor !== null) {
      query.set("cursor", cursor);
    }

    const response = await request.get(`/api/tasks?${query.toString()}`);
    expect(response.ok()).toBe(true);
    const page = (await response.json()) as TaskPage;
    taskIds.push(...page.tasks.map((task) => task.id));
    cursor = page.nextCursor;
  } while (cursor !== null);

  for (const taskId of taskIds) {
    const response = await request.delete(`/api/tasks/${encodeURIComponent(taskId)}`);
    expect(response.status()).toBe(204);
  }
}

function captureBrowserFailures(page: Page): {
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
} {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`);
  });

  return { pageErrors, consoleErrors, failedRequests };
}

test.describe.serial("generated TODO app", () => {
  test("supports CRUD and persists state across a reload", async ({ page, request }) => {
    await clearTasks(request);
    const failures = captureBrowserFailures(page);

    await page.goto("/");
    await expect(page.getByText("Personal TODO", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today's tasks" })).toBeVisible();

    const taskTitle = page.getByRole("textbox", { name: "Task title" });
    await expect(taskTitle).toBeVisible();

    await taskTitle.fill("Buy oat milk");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Buy oat milk", { exact: true })).toBeVisible();

    await taskTitle.fill("Read agent report");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Read agent report", { exact: true })).toBeVisible();

    await page.getByRole("checkbox", { name: "Mark Buy oat milk complete" }).click();
    await expect(page.getByRole("checkbox", { name: "Mark Buy oat milk active" })).toBeChecked();

    const deleteResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "DELETE" && response.url().includes("/api/tasks/"),
    );
    await page.getByRole("button", { name: "Delete Read agent report" }).click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status()).toBe(204);
    expect(await deleteResponse.finished()).toBeNull();
    await expect(page.getByText("Read agent report", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("Buy oat milk", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Mark Buy oat milk active" })).toBeChecked();
    await expect(page.getByText("Read agent report", { exact: true })).toHaveCount(0);

    expect(failures.pageErrors).toEqual([]);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.failedRequests).toEqual([]);
  });

  test("keeps the completed task after an app-container restart", async ({ page }) => {
    const failures = captureBrowserFailures(page);

    await page.goto("/");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("Buy oat milk", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Mark Buy oat milk active" })).toBeChecked();

    expect(failures.pageErrors).toEqual([]);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.failedRequests).toEqual([]);
  });
});
