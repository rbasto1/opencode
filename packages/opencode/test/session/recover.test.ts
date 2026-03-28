import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionRecover } from "../../src/session/recover"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"

function clear() {
  Database.use((db) => {
    db.delete(PartTable).run()
    db.delete(MessageTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
}

function seed() {
  const time = Date.now() - 1_000
  const project = ProjectID.make("pro_test")
  const session = SessionID.make("ses_test")
  const parent = MessageID.make("msg_parent")
  const stale = MessageID.make("msg_stale")
  const done = MessageID.make("msg_done")
  const running = PartID.make("prt_running")
  const finished = PartID.make("prt_done")

  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: project,
        worktree: "/tmp/test",
        sandboxes: [],
        time_created: time,
        time_updated: time,
      })
      .run()

    db.insert(SessionTable)
      .values({
        id: session,
        project_id: project,
        slug: session,
        directory: "/tmp/test",
        title: "test",
        version: "0.0.0-test",
        time_created: time,
        time_updated: time,
      })
      .run()

    db.insert(MessageTable)
      .values({
        id: stale,
        session_id: session,
        time_created: time,
        time_updated: time,
        data: {
          role: "assistant",
          time: { created: time },
          parentID: parent,
          modelID: ModelID.make("model"),
          providerID: ProviderID.anthropic,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/test", root: "/tmp/test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as (typeof MessageTable.$inferInsert)["data"],
      })
      .run()

    db.insert(MessageTable)
      .values({
        id: done,
        session_id: session,
        time_created: time,
        time_updated: time,
        data: {
          role: "assistant",
          time: { created: time, completed: time + 10 },
          parentID: parent,
          modelID: ModelID.make("model"),
          providerID: ProviderID.anthropic,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/test", root: "/tmp/test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        } as (typeof MessageTable.$inferInsert)["data"],
      })
      .run()

    db.insert(PartTable)
      .values({
        id: running,
        message_id: stale,
        session_id: session,
        time_created: time,
        time_updated: time,
        data: {
          type: "tool",
          callID: "call_1",
          tool: "bash",
          state: {
            status: "running",
            input: { cmd: "pwd" },
            time: { start: time },
          },
        } as (typeof PartTable.$inferInsert)["data"],
      })
      .run()

    db.insert(PartTable)
      .values({
        id: finished,
        message_id: stale,
        session_id: session,
        time_created: time,
        time_updated: time,
        data: {
          type: "tool",
          callID: "call_2",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "ok",
            title: "ok",
            metadata: {},
            time: { start: time, end: time + 1 },
          },
        } as (typeof PartTable.$inferInsert)["data"],
      })
      .run()
  })

  return { stale, done, running, finished }
}

describe("SessionRecover.run", () => {
  beforeEach(clear)
  afterEach(clear)

  test("finalizes stale assistant messages and running tools", async () => {
    const ids = seed()

    const result = await SessionRecover.run()

    expect(result).toEqual({ messages: 1, parts: 1 })

    const stale = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, ids.stale)).get())!
    const staleData = stale.data as MessageV2.Assistant
    expect(staleData.time.completed).toBeNumber()
    expect(staleData.error).toEqual({
      name: "MessageAbortedError",
      data: { message: "The operation was aborted." },
    })

    const done = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, ids.done)).get())!
    const doneData = done.data as MessageV2.Assistant
    expect(doneData.time.completed).toBeDefined()
    expect(doneData.finish).toBe("stop")

    const running = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, ids.running)).get())!
    const runningData = running.data as MessageV2.ToolPart
    expect(runningData.state).toEqual({
      status: "error",
      input: { cmd: "pwd" },
      error: "Tool execution aborted",
      time: {
        start: expect.any(Number),
        end: expect.any(Number),
      },
    })

    const finished = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, ids.finished)).get())!
    const finishedData = finished.data as MessageV2.ToolPart
    expect(finishedData.state.status).toBe("completed")
  })
})
