import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  workspaceFileResourceQuerySchema,
  type ResolvedWorkspaceResource,
  type WorkspaceFileContent,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { workspaceFileResourceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

export type WorkspaceFileResourceService = {
  getIssue(issueId: string): Promise<{ companyId: string }>;
  resolve(issueId: string, input: { path: string; workspace?: "auto" | "execution" | "project" | null }): Promise<ResolvedWorkspaceResource>;
  readContent(issueId: string, input: { path: string; workspace?: "auto" | "execution" | "project" | null }): Promise<WorkspaceFileContent>;
};

type FileResourceLimiter = {
  acquire(key: string): () => void;
};

export function createFileResourceLimiter(opts: {
  maxConcurrent?: number;
  maxRequests?: number;
  windowMs?: number;
} = {}): FileResourceLimiter {
  const maxConcurrent = opts.maxConcurrent ?? 6;
  const maxRequests = opts.maxRequests ?? 120;
  const windowMs = opts.windowMs ?? 60_000;
  const activeByKey = new Map<string, number>();
  const windowsByKey = new Map<string, { startedAt: number; count: number }>();

  return {
    acquire(key: string) {
      const now = Date.now();
      const window = windowsByKey.get(key);
      if (!window || now - window.startedAt >= windowMs) {
        windowsByKey.set(key, { startedAt: now, count: 1 });
      } else {
        window.count += 1;
        if (window.count > maxRequests) {
          throw new HttpError(429, "Too many file preview requests");
        }
      }

      const active = activeByKey.get(key) ?? 0;
      if (active >= maxConcurrent) {
        throw new HttpError(429, "Too many concurrent file preview requests");
      }
      activeByKey.set(key, active + 1);
      return () => {
        const current = activeByKey.get(key) ?? 0;
        if (current <= 1) activeByKey.delete(key);
        else activeByKey.set(key, current - 1);
      };
    },
  };
}

function limiterKey(companyId: string, actorId: string, issueId: string) {
  return `${companyId}:${actorId}:${issueId}`;
}

function readQuery(query: unknown) {
  const parsed = workspaceFileResourceQuerySchema.parse(query);
  return {
    path: parsed.path,
    workspace: parsed.workspace ?? "auto",
  };
}

function activityDetails(input: {
  outcome: "success" | "denied";
  workspaceKind?: string | null;
  workspaceId?: string | null;
  displayPath?: string | null;
  denialReason?: string | null;
  byteSize?: number | null;
  contentType?: string | null;
}) {
  return {
    outcome: input.outcome,
    ...(input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.displayPath ? { displayPath: input.displayPath } : {}),
    ...(input.denialReason ? { denialReason: input.denialReason } : {}),
    ...(typeof input.byteSize === "number" ? { byteSize: input.byteSize } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
  };
}

function denialReasonFromError(error: unknown) {
  if (!(error instanceof HttpError)) return "unknown";
  const details = error.details;
  if (details && typeof details === "object" && "code" in details) {
    const code = (details as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return error.message;
}

export function fileResourceRoutes(db: Db, opts: {
  service?: WorkspaceFileResourceService;
  limiter?: FileResourceLimiter;
} = {}) {
  const router = Router();
  const svc = opts.service ?? workspaceFileResourceService(db);
  const limiter = opts.limiter ?? createFileResourceLimiter();

  async function logDeniedAttempt(input: {
    companyId: string;
    actor: ReturnType<typeof getActorInfo>;
    issueId: string;
    displayPath: string;
    error: unknown;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      action: "issue.file_resource_content_denied",
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      details: activityDetails({
        outcome: "denied",
        displayPath: input.displayPath,
        denialReason: denialReasonFromError(input.error),
      }),
    });
  }

  router.get("/issues/:issueId/file-resources/resolve", async (req, res) => {
    assertBoard(req);
    const issue = await svc.getIssue(req.params.issueId);
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const query = readQuery(req.query);
    const release = limiter.acquire(limiterKey(issue.companyId, actor.actorId, req.params.issueId));
    try {
      const result = await svc.resolve(req.params.issueId, query);
      res.json(result);
    } catch (error) {
      await logDeniedAttempt({
        companyId: issue.companyId,
        actor,
        issueId: req.params.issueId,
        displayPath: query.path,
        error,
      });
      throw error;
    } finally {
      release();
    }
  });

  router.get("/issues/:issueId/file-resources/content", async (req, res) => {
    assertBoard(req);
    const issue = await svc.getIssue(req.params.issueId);
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const query = readQuery(req.query);
    const release = limiter.acquire(limiterKey(issue.companyId, actor.actorId, req.params.issueId));
    try {
      let result: WorkspaceFileContent | null = null;
      try {
        result = await svc.readContent(req.params.issueId, query);
      } catch (error) {
        await logDeniedAttempt({
          companyId: issue.companyId,
          actor,
          issueId: req.params.issueId,
          displayPath: query.path,
          error,
        });
        throw error;
      }

      if (!result) throw unprocessable("Workspace file cannot be previewed");
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "issue.file_resource_content_read",
        entityType: "issue",
        entityId: req.params.issueId,
        agentId: actor.agentId,
        runId: actor.runId,
        details: activityDetails({
          outcome: "success",
          workspaceKind: result.resource.workspaceKind,
          workspaceId: result.resource.workspaceId,
          displayPath: result.resource.displayPath,
          byteSize: result.resource.byteSize ?? null,
          contentType: result.resource.contentType ?? null,
        }),
      });

      res.set("X-Content-Type-Options", "nosniff");
      res.json(result);
    } finally {
      release();
    }
  });

  return router;
}
