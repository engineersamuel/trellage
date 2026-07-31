Build and fully verify a production-ready personal TODO web application in the current `/workspace` repository. Use the customization packages, plugins, skills, agents, and workflows installed in this isolated agent environment when they apply. Work autonomously until every requirement and check below passes; do not stop at a plan or ask the user to finish any step.

## Product contract

Create a polished responsive single-page UI with the visible title `Personal TODO` and an `Today's tasks` heading. The page must let a user:

- enter a task through a textbox whose accessible name is `Task title`;
- create it with a button whose accessible name is `Add task`;
- view current tasks as semantic list items;
- toggle completion with a checkbox named `Mark <title> complete` while active and `Mark <title> active` while completed;
- delete a task with a button named `Delete <title>`;
- reload the page without losing state;
- load additional tasks through an accessible `Load more tasks` control when pagination has another page.

Use durable SQLite storage under `DATA_DIR` (default `/data`). Task ordering and pagination must be deterministic and must not skip or duplicate tasks when records change between requests.

## HTTP contract

Implement these routes:

- `GET /health` returns HTTP 200 with JSON showing the service is healthy.
- `GET /api/tasks?limit=<n>&cursor=<opaque>` returns `{ "tasks": [...], "nextCursor": string | null }`.
- `POST /api/tasks` validates a non-empty title and creates a task.
- `PATCH /api/tasks/:id` updates the title or completed state with validation.
- `DELETE /api/tasks/:id` deletes a task and returns HTTP 204.

Return structured JSON errors for invalid input and missing tasks. The browser client must consume the DELETE response body before completing the request so Chromium does not report a failed request for the HTTP 204 response.

## Runtime and repository contract

- Use Node.js and TypeScript. Framework and internal architecture are your choice.
- Bind to `HOST=0.0.0.0` by default and use `PORT=3000` by default.
- Leave `package.json`, `package-lock.json`, production `node_modules`, and the production `dist` output in `/workspace`.
- `npm run start` must launch the production server from `/workspace` without downloading or building anything.
- Provide working scripts for `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run start`.
- Keep application code, tests, and configuration in this repository. Do not use another container, a host path, or an external database.
- Do not commit secrets or require credentials at application runtime.

## Verification contract

Before finishing:

1. Run the full automated test suite, including API validation, CRUD, deterministic cursor pagination, persistence, and the 204-response browser regression.
2. Run type checking, linting, the production build, and a production dependency audit.
3. Start the production app and exercise the health endpoint and complete browser CRUD flow.
4. Fix every discovered in-scope failure and rerun the affected checks.
5. Leave the final build and installed production dependencies ready for the external app container.

Finish only after the application is complete and all available checks pass. In the final response, summarize what was built and list the exact verification results.
