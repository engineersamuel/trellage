// Plain HTTP on a tailnet IP is not a secure context, so browsers omit crypto.randomUUID.
// CopilotKit and the thread picker need it; getRandomValues still works there.
if (typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = () =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (+c / 4)))).toString(16),
    ) as `${string}-${string}-${string}-${string}-${string}`;
}
export {};
