import { beforeEach, describe, expect, test } from "bun:test"
import { resetDatabase } from "../fixture/db"
import { Database, eq } from "../../src/storage/db"
import { Sync } from "../../src/sync"
import { SyncOutboxTable } from "../../src/sync/sync.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionTable, MessageTable, TodoTable } from "../../src/session/session.sql"

const project = {
  id: "project_test",
  worktree: "/tmp/project",
  vcs: "git",
  name: "demo",
  icon_url: null,
  icon_color: null,
  time_created: 1,
  time_updated: 1,
  time_initialized: null,
  sandboxes: [],
  commands: null,
}

describe("sync", () => {
  beforeEach(async () => {
    await resetDatabase()
    delete process.env.OPENCODE_SYNC_POSTGRES_URL
    delete process.env.OPENCODE_SYNC_DEVICE
  })

  test("queues local outbox events when sync is enabled", () => {
    process.env.OPENCODE_SYNC_POSTGRES_URL = "postgres://example"
    Sync.emit({ kind: "project.upsert", row: project })

    const row = Database.use((db) => db.select().from(SyncOutboxTable).get())
    expect(row?.kind).toBe("project.upsert")
  })

  test("replays project session message and todo events into local sqlite", async () => {
    await Sync.apply({ kind: "project.upsert", row: project })
    await Sync.apply({
      kind: "session.upsert",
      row: {
        id: "ses_test",
        project_id: "project_test",
        workspace_id: null,
        parent_id: null,
        slug: "slug",
        directory: "/tmp/project",
        title: "Session",
        version: "1",
        share_url: null,
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        summary_diffs: null,
        revert: null,
        permission: null,
        time_created: 1,
        time_updated: 1,
        time_compacting: null,
        time_archived: null,
      },
    })
    await Sync.apply({
      kind: "message.upsert",
      row: {
        id: "msg_test",
        session_id: "ses_test",
        time_created: 2,
        time_updated: 2,
        data: {} as never,
      },
    })
    await Sync.apply({
      kind: "todo.replace",
      sessionID: "ses_test",
      rows: [
        {
          session_id: "ses_test",
          content: "ship it",
          status: "pending",
          priority: "high",
          position: 0,
          time_created: 3,
          time_updated: 3,
        },
      ],
    })

    const storedProject = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, "project_test")).get())
    const session = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, "ses_test")).get())
    const message = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, "msg_test")).get())
    const todo = Database.use((db) => db.select().from(TodoTable).where(eq(TodoTable.session_id, "ses_test")).get())

    expect(storedProject?.worktree).toBe("/tmp/project")
    expect(session?.title).toBe("Session")
    expect(message?.session_id).toBe("ses_test")
    expect(todo?.content).toBe("ship it")
  })
})
