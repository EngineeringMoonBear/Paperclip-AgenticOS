import { z } from "zod";

export const workspaceFileWorkspaceKindSchema = z.enum(["execution_workspace", "project_workspace"]);
export const workspaceFileSelectorSchema = z.enum(["auto", "execution", "project"]).default("auto");
export const workspaceFilePreviewKindSchema = z.enum(["text", "image", "pdf", "unsupported"]);
export const workspaceFileResourceKindSchema = z.enum(["file", "remote_resource"]);

export const workspaceFileRefSchema = z.object({
  kind: z.literal("workspace_file"),
  issueId: z.string().uuid(),
  workspaceKind: workspaceFileWorkspaceKindSchema,
  workspaceId: z.string().uuid(),
  relativePath: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  column: z.number().int().positive().nullable().optional(),
  displayPath: z.string().min(1),
});

export const workspaceFileResourceQuerySchema = z.object({
  path: z.string().min(1),
  workspace: workspaceFileSelectorSchema.optional(),
});

export const resolvedWorkspaceResourceSchema = z.object({
  kind: workspaceFileResourceKindSchema,
  provider: z.string().min(1),
  title: z.string().min(1),
  displayPath: z.string().min(1),
  workspaceLabel: z.string().min(1),
  workspaceKind: workspaceFileWorkspaceKindSchema,
  workspaceId: z.string().uuid(),
  contentType: z.string().nullable().optional(),
  byteSize: z.number().int().nonnegative().nullable().optional(),
  previewKind: workspaceFilePreviewKindSchema,
  denialReason: z.string().nullable().optional(),
  capabilities: z.object({
    preview: z.boolean(),
    download: z.literal(false),
    listChildren: z.literal(false),
  }),
});

export const workspaceFileContentSchema = z.object({
  resource: resolvedWorkspaceResourceSchema,
  content: z.object({
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
  }),
});

export type WorkspaceFileResourceQuery = z.infer<typeof workspaceFileResourceQuerySchema>;
