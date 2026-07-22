import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deriveManualIssueIdempotencyFingerprint,
  isIssueIdempotentReplay,
  issueService,
} from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("manual issue create idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
    });
    return { companyId, agentId };
  }

  it("derives a non-default fingerprint for manual creates", async () => {
    const { companyId, agentId } = await seedCompany();
    const svc = issueService(db);
    const issue = await svc.create(companyId, {
      title: "Fix the broken thing",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(issue.originKind).toBe("manual");
    expect(issue.originFingerprint).not.toBe("default");
    expect(issue.originFingerprint).toBe(
      deriveManualIssueIdempotencyFingerprint({
        parentId: null,
        title: "Fix the broken thing",
        assigneeAgentId: agentId,
      }),
    );
  });

  it("returns the existing row for a retried identical create", async () => {
    const { companyId, agentId } = await seedCompany();
    const svc = issueService(db);
    const first = await svc.create(companyId, {
      title: "Fix the broken thing",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const retry = await svc.create(companyId, {
      title: "Fix the broken thing",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(retry.id).toBe(first.id);
    expect(isIssueIdempotentReplay(retry)).toBe(true);
    expect(isIssueIdempotentReplay(first)).toBe(false);
    const rows = await db.select().from(issues);
    expect(rows).toHaveLength(1);
  });

  it("honors an explicit idempotency fingerprint", async () => {
    const { companyId } = await seedCompany();
    const svc = issueService(db);
    const first = await svc.create(companyId, {
      title: "Ship the report",
      status: "todo",
      originFingerprint: "client-key-1",
    });
    const retry = await svc.create(companyId, {
      title: "Ship the report (retitled retry)",
      status: "todo",
      originFingerprint: "client-key-1",
    });
    expect(retry.id).toBe(first.id);
    expect(isIssueIdempotentReplay(retry)).toBe(true);
  });

  it("allows re-creating after the previous issue is done or cancelled", async () => {
    const { companyId, agentId } = await seedCompany();
    const svc = issueService(db);
    const first = await svc.create(companyId, {
      title: "Recurring chore",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await svc.update(first.id, { status: "done" });
    const second = await svc.create(companyId, {
      title: "Recurring chore",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(second.id).not.toBe(first.id);
    expect(isIssueIdempotentReplay(second)).toBe(false);
  });

  it("does not deduplicate rows that predate fingerprinting", async () => {
    const { companyId, agentId } = await seedCompany();
    const svc = issueService(db);
    await db.insert(issues).values({
      companyId,
      title: "Legacy issue",
      status: "todo",
      originKind: "manual",
      originFingerprint: "default",
      issueNumber: 1,
      identifier: "LEG-1",
    });
    const created = await svc.create(companyId, {
      title: "Legacy issue",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(isIssueIdempotentReplay(created)).toBe(false);
    const rows = await db.select().from(issues);
    expect(rows).toHaveLength(2);
  });

  it("scopes deduplication by parent and assignee", async () => {
    const { companyId, agentId } = await seedCompany();
    const svc = issueService(db);
    const unassigned = await svc.create(companyId, { title: "Same title", status: "todo" });
    const assigned = await svc.create(companyId, {
      title: "Same title",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(assigned.id).not.toBe(unassigned.id);
    const child = await svc.create(companyId, {
      title: "Same title",
      status: "todo",
      parentId: unassigned.id,
    });
    expect(child.id).not.toBe(unassigned.id);
    expect(isIssueIdempotentReplay(child)).toBe(false);
  });
});
