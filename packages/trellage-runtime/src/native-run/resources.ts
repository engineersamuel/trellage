import path from "node:path"

export const resolveShippedResource = (reference: string, shippedRoot: string): string => {
  if (!reference.startsWith("shipped:")) throw new Error("expected a shipped resource reference")
  const relative = reference.slice(8)
  if (
    !relative ||
    /[\\:\u0000-\u001f\u007f]/u.test(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid shipped resource reference")
  const root = path.resolve(shippedRoot),
    resolved = path.resolve(root, relative)
  if (!resolved.startsWith(root + path.sep)) throw new Error("shipped resource escapes its root")
  return resolved
}
export const resolveInstructionFile = (reference: string, configDirectory: string, shippedRoot: string): string =>
  reference.startsWith("shipped:")
    ? resolveShippedResource(reference, shippedRoot)
    : path.resolve(configDirectory, reference)
