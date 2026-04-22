export type WorkspaceFileWorkspaceKind = "execution_workspace" | "project_workspace";
export type WorkspaceFileSelector = "auto" | "execution" | "project";
export type WorkspaceFilePreviewKind = "text" | "image" | "pdf" | "unsupported";
export type WorkspaceFileResourceKind = "file" | "remote_resource";
export type WorkspaceFileContentEncoding = "utf8" | "base64";

export interface WorkspaceFileRef {
  kind: "workspace_file";
  issueId: string;
  workspaceKind: WorkspaceFileWorkspaceKind;
  workspaceId: string;
  relativePath: string;
  line?: number | null;
  column?: number | null;
  displayPath: string;
}

export interface ResolvedWorkspaceResource {
  kind: WorkspaceFileResourceKind;
  provider: "local_fs" | "git_worktree" | "remote_managed" | string;
  title: string;
  displayPath: string;
  workspaceLabel: string;
  workspaceKind: WorkspaceFileWorkspaceKind;
  workspaceId: string;
  contentType?: string | null;
  byteSize?: number | null;
  previewKind: WorkspaceFilePreviewKind;
  denialReason?: string | null;
  capabilities: {
    preview: boolean;
    download: false;
    listChildren: false;
  };
}

export interface WorkspaceFileContent {
  resource: ResolvedWorkspaceResource;
  content: {
    encoding: WorkspaceFileContentEncoding;
    data: string;
  };
}
