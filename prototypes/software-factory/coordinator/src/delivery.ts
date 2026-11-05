// Handing a prompt to a coordinator that may be busy.

/** What a prompt is handed to: a worker's status and send. */
export type Recipient = { readonly status: string; send: (prompt: string) => Promise<void> }

/** Wait while the recipient is running, run `prepare`, then send. Settles when the send does; rejects with it. */
export const sendWhenIdle = async (c: Recipient, prompt: string, prepare: () => void, pollMs = 2000): Promise<void> => {
  while (c.status === "running") await new Promise((r) => setTimeout(r, pollMs))
  prepare()
  await c.send(prompt)
}
