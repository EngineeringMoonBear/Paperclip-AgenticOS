import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projectWorkspaces } from "@paperclipai/db";
import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFilePreviewKind,
  WorkspaceFileSelector,
  WorkspaceFileWorkspaceKind,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";

export const WORKSPACE_FILE_TEXT_MAX_BYTES = 512 * 1024;
export const WORKSPACE_FILE_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4096;
const TEXT_SNIFF_BYTES = 4096;

const DENIED_SEGMENTS = new Set([
  ".git",
  ".paperclip",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".cache",
  ".turbo",
  ".next",
  ".vite",
  ".vercel",
  "dist",
  "build",
  "coverage",
  "runtime-services",
  ".runtime",
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".htm",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const IMAGE_CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

type IssueRow = typeof issues.$inferSelect;
type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;

type WorkspaceCandidate = {
  workspaceKind: WorkspaceFileWorkspaceKind;
  workspaceId: string;
  provider: string;
  label: string;
  rootPath: string | null;
  remote: boolean;
};

type NormalizedPath = {
  relativePath: string;
  segments: string[];
};

type LocalResolvedFile = {
  resource: ResolvedWorkspaceResource;
  realPath: string;
};

function previewCapForKind(kind: WorkspaceFilePreviewKind) {
  return kind === "image" || kind === "pdf" ? WORKSPACE_FILE_MEDIA_MAX_BYTES : WORKSPACE_FILE_TEXT_MAX_BYTES;
}

function relativePathFromReal(rootReal: string, targetReal: string) {
  return path.relative(rootReal, targetReal).split(path.sep).join(path.posix.sep);
}

function normalizeWorkspaceRelativePath(input: string): NormalizedPath {
  const trimmed = input.trim();
  if (!trimmed) throw unprocessable("Workspace file path is required", { code: "invalid_path" });
  if (Buffer.byteLength(trimmed, "utf8") > MAX_RELATIVE_PATH_BYTES) {
    throw unprocessable("Workspace file path is too long", { code: "invalid_path" });
  }
  if (trimmed.includes("\0")) throw unprocessable("Workspace file path contains an invalid character", { code: "invalid_path" });
  if (/^file:\/\//i.test(trimmed)) throw unprocessable("File URLs are not supported", { code: "invalid_path" });
  if (/^[a-zA-Z]:/.test(trimmed)) throw unprocessable("Windows drive paths are not supported", { code: "invalid_path" });
  if (trimmed.includes("\\")) throw unprocessable("Workspace file paths must use forward slashes", { code: "invalid_path" });
  if (path.posix.isAbsolute(trimmed)) throw unprocessable("Workspace file path must be relative", { code: "invalid_path" });

  const normalized = path.posix.normalize(trimmed);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new HttpError(403, "Workspace file path is outside the workspace", { code: "outside_workspace" });
  }

  return {
    relativePath: normalized,
    segments: normalized.split("/").filter(Boolean),
  };
}

function denyReasonForPathSegments(segments: string[]): string | null {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => DENIED_SEGMENTS.has(segment))) return "denied_path_segment";

  const fileName = lowerSegments.at(-1) ?? "";
  if (fileName === ".env" || fileName.startsWith(".env.")) return "denied_secret";
  if (fileName.endsWith(".pem") || fileName.endsWith(".key") || fileName.endsWith(".p12") || fileName.endsWith(".pfx")) {
    return "denied_secret";
  }
  if (["id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", "kubeconfig"].includes(fileName)) return "denied_secret";
  if (lowerSegments.includes(".aws") || lowerSegments.includes(".ssh")) return "denied_secret";
  if (lowerSegments.length >= 2 && lowerSegments.at(-2) === ".docker" && fileName === "config.json") return "denied_secret";
  if (lowerSegments.length >= 2 && lowerSegments.at(-2) === ".kube" && fileName === "config") return "denied_secret";

  return null;
}

function throwIfDenied(segments: string[]) {
  const denialReason = denyReasonForPathSegments(segments);
  if (denialReason) {
    throw new HttpError(403, "Workspace file path is denied by policy", { code: denialReason });
  }
}

function contentTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_CONTENT_TYPES.has(ext)) return IMAGE_CONTENT_TYPES.get(ext) ?? null;
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  return null;
}

function previewKindForKnownContentType(contentType: string | null): WorkspaceFilePreviewKind | null {
  if (!contentType) return null;
  if (contentType.startsWith("image/") && contentType !== "image/svg+xml") return "image";
  if (contentType === "application/pdf") return "pdf";
  if (contentType === "text/html") return "unsupported";
  if (contentType === "image/svg+xml" || contentType.startsWith("text/")) return "text";
  return "unsupported";
}

function looksLikeText(buffer: Buffer) {
  if (buffer.length === 0) return true;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes += 1;
  }
  return controlBytes / buffer.length < 0.02;
}

async function sniffUnknownPreviewKind(realPath: string): Promise<WorkspaceFilePreviewKind> {
  const handle = await fs.open(realPath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_SNIFF_BYTES, 0);
    return looksLikeText(buffer.subarray(0, bytesRead)) ? "text" : "unsupported";
  } finally {
    await handle.close();
  }
}

function remoteResource(candidate: WorkspaceCandidate, relativePath: string): ResolvedWorkspaceResource {
  return {
    kind: "remote_resource",
    provider: candidate.provider || "remote_managed",
    title: path.posix.basename(relativePath),
    displayPath: relativePath,
    workspaceLabel: candidate.label,
    workspaceKind: candidate.workspaceKind,
    workspaceId: candidate.workspaceId,
    contentType: null,
    byteSize: null,
    previewKind: "unsupported",
    denialReason: "remote_workspace",
    capabilities: {
      preview: false,
      download: false,
      listChildren: false,
    },
  };
}

function candidateFromExecutionWorkspace(row: ExecutionWorkspaceRow): WorkspaceCandidate {
  const provider = row.providerType || row.strategyType || "local_fs";
  const rootPath = row.cwd || row.providerRef || null;
  const remote = !["local_fs", "git_worktree"].includes(provider) || !rootPath || row.status !== "active" || row.closedAt != null;
  return {
    workspaceKind: "execution_workspace",
    workspaceId: row.id,
    provider,
    label: row.name,
    rootPath,
    remote,
  };
}

function candidateFromProjectWorkspace(row: ProjectWorkspaceRow): WorkspaceCandidate {
  const provider = row.sourceType === "git_worktree" ? "git_worktree" : row.sourceType === "local_path" ? "local_fs" : row.sourceType;
  const rootPath = row.cwd ?? null;
  const remote = !["local_fs", "git_worktree"].includes(provider) || !rootPath;
  return {
    workspaceKind: "project_workspace",
    workspaceId: row.id,
    provider,
    label: row.name,
    rootPath,
    remote,
  };
}

async function statLocalCandidate(candidate: WorkspaceCandidate, normalized: NormalizedPath): Promise<LocalResolvedFile> {
  if (!candidate.rootPath) {
    throw unprocessable("Workspace is not locally readable", { code: "remote_workspace" });
  }
  throwIfDenied(normalized.segments);

  let rootReal: string;
  try {
    rootReal = await fs.realpath(candidate.rootPath);
  } catch {
    throw unprocessable("Workspace is not available on this host", { code: "workspace_unavailable" });
  }

  const targetLexical = path.resolve(rootReal, ...normalized.segments);
  let targetReal: string;
  try {
    targetReal = await fs.realpath(targetLexical);
  } catch {
    throw notFound("Workspace file not found");
  }

  const realRelative = path.relative(rootReal, targetReal);
  if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new HttpError(403, "Workspace file path is outside the workspace", { code: "outside_workspace" });
  }
  throwIfDenied(relativePathFromReal(rootReal, targetReal).split("/").filter(Boolean));

  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) {
    throw unprocessable("Workspace file is not a regular file", { code: "not_regular_file" });
  }

  const contentType = contentTypeForPath(normalized.relativePath);
  let previewKind = previewKindForKnownContentType(contentType);
  if (!previewKind) {
    previewKind = await sniffUnknownPreviewKind(targetReal);
  }

  const cap = previewCapForKind(previewKind);
  const tooLarge = stat.size > cap;
  const unsupported = previewKind === "unsupported";
  const denialReason = tooLarge ? "too_large" : unsupported ? "unsupported_content" : null;

  return {
    realPath: targetReal,
    resource: {
      kind: "file",
      provider: candidate.provider,
      title: path.posix.basename(normalized.relativePath),
      displayPath: normalized.relativePath,
      workspaceLabel: candidate.label,
      workspaceKind: candidate.workspaceKind,
      workspaceId: candidate.workspaceId,
      contentType: contentType ?? (previewKind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream"),
      byteSize: stat.size,
      previewKind,
      denialReason,
      capabilities: {
        preview: !tooLarge && !unsupported,
        download: false,
        listChildren: false,
      },
    },
  };
}

async function readStableFile(realPath: string, maxBytes: number) {
  const handle = await fs.open(realPath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw unprocessable("Workspace file is not a regular file", { code: "not_regular_file" });
    if (before.size > maxBytes) throw unprocessable("Workspace file is too large to preview", { code: "too_large" });
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.mtimeMs !== before.mtimeMs) {
      throw unprocessable("Workspace file changed while being read", { code: "file_changed" });
    }
    return data;
  } finally {
    await handle.close();
  }
}

export function workspaceFileResourceService(db: Db) {
  async function getIssue(issueId: string): Promise<IssueRow> {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function listCandidates(issue: IssueRow, selector: WorkspaceFileSelector): Promise<WorkspaceCandidate[]> {
    const candidates: WorkspaceCandidate[] = [];
    if ((selector === "auto" || selector === "execution") && issue.projectId) {
      const executionIds = [issue.executionWorkspaceId].filter((id): id is string => Boolean(id));
      let executionRows: ExecutionWorkspaceRow[] = [];
      if (executionIds.length > 0) {
        executionRows = await db.select().from(executionWorkspaces).where(
          and(
            eq(executionWorkspaces.companyId, issue.companyId),
            inArray(executionWorkspaces.id, executionIds),
          ),
        );
      }
      const sourceIssueIds = [issue.id, issue.parentId].filter((id): id is string => Boolean(id));
      if (sourceIssueIds.length > 0) {
        const activeRows = await db.select().from(executionWorkspaces).where(
          and(
            eq(executionWorkspaces.companyId, issue.companyId),
            eq(executionWorkspaces.projectId, issue.projectId),
            inArray(executionWorkspaces.sourceIssueId, sourceIssueIds),
            eq(executionWorkspaces.status, "active"),
            isNull(executionWorkspaces.closedAt),
          ),
        ).orderBy(desc(executionWorkspaces.lastUsedAt)).limit(2);
        executionRows = [...executionRows, ...activeRows];
      }
      const seen = new Set<string>();
      for (const row of executionRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        candidates.push(candidateFromExecutionWorkspace(row));
      }
    }

    if ((selector === "auto" || selector === "project") && issue.projectId) {
      if (issue.projectWorkspaceId) {
        const rows = await db.select().from(projectWorkspaces).where(
          and(
            eq(projectWorkspaces.companyId, issue.companyId),
            eq(projectWorkspaces.projectId, issue.projectId),
            eq(projectWorkspaces.id, issue.projectWorkspaceId),
          ),
        ).limit(1);
        if (rows[0]) candidates.push(candidateFromProjectWorkspace(rows[0]));
      }
      const primaryRows = await db.select().from(projectWorkspaces).where(
        and(
          eq(projectWorkspaces.companyId, issue.companyId),
          eq(projectWorkspaces.projectId, issue.projectId),
          eq(projectWorkspaces.isPrimary, true),
        ),
      ).limit(1);
      if (primaryRows[0] && !candidates.some((candidate) => candidate.workspaceId === primaryRows[0]!.id)) {
        candidates.push(candidateFromProjectWorkspace(primaryRows[0]));
      }
    }

    return candidates;
  }

  async function resolve(issueId: string, input: {
    path: string;
    workspace?: WorkspaceFileSelector | null;
  }): Promise<ResolvedWorkspaceResource> {
    const issue = await getIssue(issueId);
    const selector = input.workspace ?? "auto";
    const normalized = normalizeWorkspaceRelativePath(input.path);
    const candidates = await listCandidates(issue, selector);
    if (candidates.length === 0) {
      throw unprocessable("No workspace is available for this issue", { code: "no_workspace" });
    }

    let lastNotFound: unknown = null;
    for (const candidate of candidates) {
      if (candidate.remote) {
        if (selector !== "auto") return remoteResource(candidate, normalized.relativePath);
        continue;
      }
      try {
        return (await statLocalCandidate(candidate, normalized)).resource;
      } catch (error) {
        if (error instanceof Error && "status" in error && (error as { status?: number }).status === 404 && selector === "auto") {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }

    if (lastNotFound) throw lastNotFound;
    throw unprocessable("No local-readable workspace is available for this issue", { code: "no_local_workspace" });
  }

  async function readContent(issueId: string, input: {
    path: string;
    workspace?: WorkspaceFileSelector | null;
  }): Promise<WorkspaceFileContent> {
    const issue = await getIssue(issueId);
    const selector = input.workspace ?? "auto";
    const normalized = normalizeWorkspaceRelativePath(input.path);
    const candidates = await listCandidates(issue, selector);
    if (candidates.length === 0) {
      throw unprocessable("No workspace is available for this issue", { code: "no_workspace" });
    }

    let lastNotFound: unknown = null;
    for (const candidate of candidates) {
      if (candidate.remote) {
        if (selector !== "auto") throw unprocessable("Remote workspaces cannot be previewed by the server", { code: "remote_workspace" });
        continue;
      }
      let resolved: LocalResolvedFile;
      try {
        resolved = await statLocalCandidate(candidate, normalized);
      } catch (error) {
        if (error instanceof Error && "status" in error && (error as { status?: number }).status === 404 && selector === "auto") {
          lastNotFound = error;
          continue;
        }
        throw error;
      }

      if (!resolved.resource.capabilities.preview) {
        throw unprocessable("Workspace file cannot be previewed", { code: resolved.resource.denialReason ?? "unsupported_content" });
      }
      const cap = previewCapForKind(resolved.resource.previewKind);
      const data = await readStableFile(resolved.realPath, cap);
      if (resolved.resource.previewKind === "text" && !looksLikeText(data.subarray(0, Math.min(data.length, TEXT_SNIFF_BYTES)))) {
        throw unprocessable("Workspace file is not a text file", { code: "binary_content" });
      }

      return {
        resource: resolved.resource,
        content: {
          encoding: resolved.resource.previewKind === "text" ? "utf8" : "base64",
          data: resolved.resource.previewKind === "text" ? data.toString("utf8") : data.toString("base64"),
        },
      };
    }

    if (lastNotFound) throw lastNotFound;
    throw unprocessable("No local-readable workspace is available for this issue", { code: "no_local_workspace" });
  }

  return {
    getIssue,
    resolve,
    readContent,
  };
}
