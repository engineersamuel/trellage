import { parse } from "yaml";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
export class ProfileGuideValidationError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = "ProfileGuideValidationError";
        this.path = path;
    }
}
const identityPart = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const skillIdentifier = /^[a-z0-9][a-z0-9._:/-]*$/u;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const singleLineControls = /[\u0000-\u001f\u007f-\u009f]/u;
const fail = (path, message) => {
    throw new ProfileGuideValidationError(path, message);
};
const record = (value, path) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail(path, "must be an object");
    }
    return value;
};
const exactKeys = (value, path, required, optional = []) => {
    const allowed = new Set([...required, ...optional]);
    const missing = required.filter((key) => !(key in value));
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
    if (missing.length > 0)
        fail(path, `missing required keys: ${missing.join(", ")}`);
    if (unexpected.length > 0)
        fail(path, `contains unsupported keys: ${unexpected.join(", ")}`);
};
const text = (value, path, maximum, options = {}) => {
    if (typeof value !== "string")
        return fail(path, "must be a string");
    const normalized = options.multiline ? value.trim() : value.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0)
        return fail(path, "must not be empty");
    if (normalized.length > maximum)
        return fail(path, `must contain at most ${maximum} characters`);
    if ((options.multiline ? controls : singleLineControls).test(normalized)) {
        return fail(path, "must not contain control characters");
    }
    return normalized;
};
const identifier = (value, path) => {
    const result = text(value, path, 128);
    if (!identityPart.test(result))
        return fail(path, "must be a lowercase kebab-case identifier");
    return result;
};
const stringArray = (value, path, options = {}) => {
    if (!Array.isArray(value))
        return fail(path, "must be an array");
    const minimum = options.minimum ?? 0;
    const maximumItems = options.maximumItems ?? 64;
    if (value.length < minimum)
        return fail(path, `must contain at least ${minimum} entries`);
    if (value.length > maximumItems)
        return fail(path, `must contain at most ${maximumItems} entries`);
    const result = value.map((item, index) => options.identifiers
        ? identifier(item, `${path}[${index}]`)
        : text(item, `${path}[${index}]`, options.itemMaximum ?? 1000));
    if (new Set(result).size !== result.length)
        return fail(path, "must contain unique entries");
    return result;
};
const prerequisites = (value, path) => {
    if (!Array.isArray(value))
        return fail(path, "must be an array");
    if (value.length > 32)
        return fail(path, "must contain at most 32 entries");
    const result = value.map((item, index) => {
        const itemPath = `${path}[${index}]`;
        const fields = record(item, itemPath);
        exactKeys(fields, itemPath, ["id", "description"]);
        return {
            id: identifier(fields.id, `${itemPath}.id`),
            description: text(fields.description, `${itemPath}.description`, 1000),
        };
    });
    if (new Set(result.map(({ id }) => id)).size !== result.length) {
        return fail(path, "must contain unique prerequisite IDs");
    }
    return result;
};
const workflows = (value, path) => {
    if (!Array.isArray(value))
        return fail(path, "must be an array");
    if (value.length === 0)
        return fail(path, "must contain at least one workflow");
    if (value.length > 32)
        return fail(path, "must contain at most 32 workflows");
    const result = value.map((item, index) => {
        const itemPath = `${path}[${index}]`;
        const fields = record(item, itemPath);
        exactKeys(fields, itemPath, ["id", "description", "examples", "promptTemplate"], ["skill"]);
        const skill = fields.skill === undefined ? undefined : text(fields.skill, `${itemPath}.skill`, 256).toLocaleLowerCase("en");
        if (skill !== undefined && !skillIdentifier.test(skill)) {
            fail(`${itemPath}.skill`, "must be a portable skill or command identifier");
        }
        const promptTemplate = text(fields.promptTemplate, `${itemPath}.promptTemplate`, 16000, {
            multiline: true,
        });
        const intentPlaceholderCount = promptTemplate.split("{{intent}}").length - 1;
        if (intentPlaceholderCount === 0) {
            fail(`${itemPath}.promptTemplate`, "must contain the {{intent}} placeholder");
        }
        if (intentPlaceholderCount > 1) {
            fail(`${itemPath}.promptTemplate`, "must contain exactly one {{intent}} placeholder");
        }
        for (const match of promptTemplate.matchAll(/\{\{([^{}]+)\}\}/gu)) {
            if (match[1] !== "intent") {
                fail(`${itemPath}.promptTemplate`, `contains unsupported placeholder: {{${match[1]}}}`);
            }
        }
        return {
            id: identifier(fields.id, `${itemPath}.id`),
            description: text(fields.description, `${itemPath}.description`, 2000),
            ...(skill === undefined ? {} : { skill }),
            examples: stringArray(fields.examples, `${itemPath}.examples`, {
                minimum: 2,
                maximumItems: 32,
                itemMaximum: 2000,
            }),
            promptTemplate,
        };
    });
    if (new Set(result.map(({ id }) => id)).size !== result.length) {
        return fail(path, "must contain unique workflow IDs");
    }
    return result;
};
const parseFrontmatter = (path, source) => {
    if (source.length > 128_000)
        fail(path, "must contain at most 128000 characters");
    const normalized = source.replace(/\r\n?/gu, "\n");
    if (!normalized.startsWith("---\n"))
        fail(path, "must start with YAML frontmatter");
    const closing = normalized.indexOf("\n---\n", 4);
    if (closing === -1)
        fail(path, "must close YAML frontmatter with ---");
    const frontmatter = normalized.slice(4, closing);
    const body = normalized.slice(closing + 5).trim();
    if (body.length === 0)
        fail(path, "must contain a Markdown body");
    try {
        return {
            value: parse(frontmatter, { merge: false, uniqueKeys: true }),
            body,
        };
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return fail(path, `contains invalid YAML: ${message}`);
    }
};
export const parseProfileGuide = (path, source) => {
    const parsed = parseFrontmatter(path, source);
    const fields = record(parsed.value, `${path} frontmatter`);
    exactKeys(fields, `${path} frontmatter`, [
        "schemaVersion",
        "capabilities",
        "bestFor",
        "avoidFor",
        "prerequisites",
        "workflows",
    ]);
    if (fields.schemaVersion !== 1)
        fail(`${path} frontmatter.schemaVersion`, "must equal 1");
    return {
        guide: {
            schemaVersion: 1,
            capabilities: stringArray(fields.capabilities, `${path} frontmatter.capabilities`, {
                minimum: 1,
                maximumItems: 64,
                identifiers: true,
            }),
            bestFor: stringArray(fields.bestFor, `${path} frontmatter.bestFor`, {
                minimum: 2,
                maximumItems: 32,
                itemMaximum: 2000,
            }),
            avoidFor: stringArray(fields.avoidFor, `${path} frontmatter.avoidFor`, {
                minimum: 2,
                maximumItems: 32,
                itemMaximum: 2000,
            }),
            prerequisites: prerequisites(fields.prerequisites, `${path} frontmatter.prerequisites`),
            workflows: workflows(fields.workflows, `${path} frontmatter.workflows`),
        },
        body: parsed.body,
    };
};
export const profileGuideIdentityKey = (identity) => identity.surface === "native" ? `native:${identity.launcher}/${identity.profile}` : `sandbox:${identity.profile}`;
export const profileGuideRelativePath = (identity) => identity.surface === "native"
    ? `native/${identity.launcher}/${identity.profile}.md`
    : `sandbox/${identity.profile}.md`;
export const parseProfileGuideIdentity = (relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.?\//u, "");
    const native = /^native\/([^/]+)\/([^/]+)\.md$/u.exec(normalized);
    if (native !== null) {
        const launcher = native[1];
        const profile = native[2];
        if (!identityPart.test(launcher) || !identityPart.test(profile)) {
            return fail(relativePath, "contains an invalid native guide identity");
        }
        return { surface: "native", launcher, profile };
    }
    const sandbox = /^sandbox\/([^/]+)\.md$/u.exec(normalized);
    if (sandbox !== null) {
        const profile = sandbox[1];
        if (!identityPart.test(profile))
            return fail(relativePath, "contains an invalid Sandbox guide identity");
        return { surface: "sandbox", profile };
    }
    return fail(relativePath, "must match native/<launcher>/<profile>.md or sandbox/<profile>.md");
};
export const validateProfileGuideCoverage = (expected, actualRelativePaths) => {
    const expectedKeys = new Set(expected.map(profileGuideIdentityKey));
    const actualKeys = new Set(actualRelativePaths.map((path) => profileGuideIdentityKey(parseProfileGuideIdentity(path))));
    return {
        missing: [...expectedKeys].filter((key) => !actualKeys.has(key)).sort(),
        unexpected: [...actualKeys].filter((key) => !expectedKeys.has(key)).sort(),
    };
};
const filesystemError = (target, operation, cause) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(target, `cannot ${operation}: ${message}`);
};
const safeGuideRoot = async (root) => {
    let status;
    try {
        status = await lstat(root);
    }
    catch (cause) {
        return filesystemError(root, "inspect guide root", cause);
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
        return fail(root, "guide root must be a non-symlink directory");
    }
    try {
        return await realpath(root);
    }
    catch (cause) {
        return filesystemError(root, "resolve guide root", cause);
    }
};
const safeGuideFile = async (root, relativePath) => {
    const candidate = path.join(root, relativePath);
    let status;
    try {
        status = await lstat(candidate);
    }
    catch (cause) {
        return filesystemError(relativePath, "inspect guide file", cause);
    }
    if (!status.isFile() || status.isSymbolicLink()) {
        return fail(relativePath, "guide must be a non-symlink regular file");
    }
    let resolved;
    try {
        resolved = await realpath(candidate);
    }
    catch (cause) {
        return filesystemError(relativePath, "resolve guide file", cause);
    }
    if (!resolved.startsWith(`${root}${path.sep}`))
        return fail(relativePath, "guide resolves outside the guide root");
    return resolved;
};
export const loadProfileGuide = async (root, identity) => {
    const resolvedRoot = await safeGuideRoot(root);
    const relativePath = profileGuideRelativePath(identity);
    const filename = await safeGuideFile(resolvedRoot, relativePath);
    let source;
    try {
        source = await readFile(filename, "utf8");
    }
    catch (cause) {
        return filesystemError(relativePath, "read guide", cause);
    }
    const document = parseProfileGuide(relativePath, source);
    return {
        identity,
        key: profileGuideIdentityKey(identity),
        relativePath,
        ...document,
    };
};
export const loadProfileGuideRegistry = async (root, identities) => {
    const keys = identities.map(profileGuideIdentityKey);
    if (new Set(keys).size !== keys.length)
        fail(root, "expected profile identities must be unique");
    const entries = await Promise.all(identities.map((identity) => loadProfileGuide(root, identity)));
    return new Map(entries.map((entry) => [entry.key, entry]));
};
const discoverMarkdown = async (root, directory) => {
    const absolute = path.join(root, directory);
    let entries;
    try {
        entries = await readdir(absolute, { withFileTypes: true });
    }
    catch (cause) {
        return filesystemError(directory, "read guide directory", cause);
    }
    const found = [];
    for (const entry of entries) {
        const relative = path.posix.join(directory, entry.name);
        if (entry.isSymbolicLink())
            fail(relative, "guide directories and files must not be symlinks");
        if (entry.isDirectory()) {
            found.push(...(await discoverMarkdown(root, relative)));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md"))
            found.push(relative);
    }
    return found;
};
export const discoverProfileGuideRelativePaths = async (root) => {
    const resolvedRoot = await safeGuideRoot(root);
    const discovered = [
        ...(await discoverMarkdown(resolvedRoot, "native")),
        ...(await discoverMarkdown(resolvedRoot, "sandbox")),
    ].sort();
    for (const relativePath of discovered)
        parseProfileGuideIdentity(relativePath);
    return discovered;
};
//# sourceMappingURL=index.js.map