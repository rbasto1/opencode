import { eq, asc, isNull } from "drizzle-orm"
import { Database } from "@/storage/db"
import { SyncOutboxTable, SyncStateTable } from "./sync.sql"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable, MessageTable, PartTable, TodoTable } from "@/session/session.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"

declare const Bun: {
  SQL: new (url: string) => {
    unsafe: (sql: string, args?: unknown[]) => Promise<unknown[]>
    begin: <T>(fn: (sql: { unsafe: (sql: string, args?: unknown[]) => Promise<unknown[]> }) => Promise<T>) => Promise<T>
    close: () => Promise<void>
  }
}

const log = Log.create({ service: "sync" })

export namespace Sync {
  type SessionRow = typeof SessionTable.$inferInsert
  type MessageRow = typeof MessageTable.$inferInsert
  type PartRow = typeof PartTable.$inferInsert
  type ProjectRow = typeof ProjectTable.$inferInsert
  type WorkspaceRow = typeof WorkspaceTable.$inferInsert
  type TodoRow = typeof TodoTable.$inferInsert

  type Event =
    | { kind: "project.upsert"; row: ProjectRow }
    | { kind: "session.upsert"; row: SessionRow }
    | { kind: "session.delete"; id: string }
    | { kind: "message.upsert"; row: MessageRow }
    | { kind: "message.delete"; sessionID: string; messageID: string }
    | { kind: "part.upsert"; row: PartRow }
    | { kind: "part.delete"; sessionID: string; partID: string }
    | { kind: "todo.replace"; sessionID: string; rows: TodoRow[] }
    | { kind: "workspace.upsert"; row: WorkspaceRow }
    | { kind: "workspace.delete"; id: string }

  const state = {
    replay: 0,
    run: undefined as Promise<void> | undefined,
  }

  function url() {
    return process.env["OPENCODE_SYNC_POSTGRES_URL"]
  }

  function enabled() {
    return !!url()
  }

  function device() {
    return process.env["OPENCODE_SYNC_DEVICE"] || `${process.platform}-${process.env["HOSTNAME"] || "local"}`
  }

  export function emit(event: Event) {
    if (!enabled() || state.replay > 0) return
    Database.use((db) => {
      db.insert(SyncOutboxTable)
        .values({
          id: Identifier.ascending("sync"),
          kind: event.kind,
          data: event as never,
          time_created: Date.now(),
        })
        .run()
    })
  }

  function set(key: string, value: unknown) {
    Database.use((db) => {
      db.insert(SyncStateTable)
        .values({ key, value: value as never, time_updated: Date.now() })
        .onConflictDoUpdate({
          target: SyncStateTable.key,
          set: { value: value as never, time_updated: Date.now() },
        })
        .run()
    })
  }

  function get<T>(key: string, fallback: T): T {
    const row = Database.use((db) => db.select().from(SyncStateTable).where(eq(SyncStateTable.key, key)).get())
    if (!row || row.value === null) return fallback
    return row.value as T
  }

  async function remote() {
    const target = url()
    if (!target) return
    const sql = new Bun.SQL(target)
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS opencode_sync_event (
        seq BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        device TEXT NOT NULL,
        kind TEXT NOT NULL,
        data JSONB NOT NULL,
        time_created BIGINT NOT NULL
      )
    `)
    return sql
  }

  export async function flush() {
    const sql = await remote()
    if (!sql) return
    try {
      const rows = Database.use((db) =>
        db.select().from(SyncOutboxTable).where(isNull(SyncOutboxTable.time_sent)).orderBy(asc(SyncOutboxTable.time_created)).all(),
      )
      for (const row of rows) {
        await sql.unsafe(
          `INSERT INTO opencode_sync_event (id, device, kind, data, time_created)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, device(), row.kind, JSON.stringify(row.data), row.time_created],
        )
        Database.use((db) => {
          db.update(SyncOutboxTable).set({ time_sent: Date.now() }).where(eq(SyncOutboxTable.id, row.id)).run()
        })
      }
    } finally {
      await sql.close()
    }
  }

  export async function apply(event: Event) {
    state.replay += 1
    try {
      Database.transaction((db) => {
        switch (event.kind) {
          case "project.upsert": {
            db.insert(ProjectTable).values(event.row).onConflictDoUpdate({ target: ProjectTable.id, set: event.row }).run()
            return
          }
          case "workspace.upsert": {
            db.insert(WorkspaceTable)
              .values(event.row)
              .onConflictDoUpdate({ target: WorkspaceTable.id, set: event.row })
              .run()
            return
          }
          case "workspace.delete": {
            db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, event.id)).run()
            return
          }
          case "session.upsert": {
            db.insert(SessionTable).values(event.row).onConflictDoUpdate({ target: SessionTable.id, set: event.row }).run()
            return
          }
          case "session.delete": {
            db.delete(SessionTable).where(eq(SessionTable.id, event.id)).run()
            return
          }
          case "message.upsert": {
            db.insert(MessageTable).values(event.row).onConflictDoUpdate({ target: MessageTable.id, set: event.row }).run()
            return
          }
          case "message.delete": {
            db.delete(MessageTable).where(eq(MessageTable.id, event.messageID)).run()
            return
          }
          case "part.upsert": {
            db.insert(PartTable).values(event.row).onConflictDoUpdate({ target: PartTable.id, set: event.row }).run()
            return
          }
          case "part.delete": {
            db.delete(PartTable).where(eq(PartTable.id, event.partID)).run()
            return
          }
          case "todo.replace": {
            db.delete(TodoTable).where(eq(TodoTable.session_id, event.sessionID)).run()
            if (event.rows.length > 0) db.insert(TodoTable).values(event.rows).run()
            return
          }
        }
      })
    } finally {
      state.replay -= 1
    }
  }

  export async function replay() {
    const sql = await remote()
    if (!sql) return
    try {
      const cursor = get<number>("sync.cursor", 0)
      const rows = (await sql.unsafe(
        `SELECT seq, data FROM opencode_sync_event WHERE seq > $1 ORDER BY seq ASC`,
        [cursor],
      )) as { seq: number | string; data: Event }[]
      for (const row of rows) {
        await apply(row.data as Event)
        set("sync.cursor", Number(row.seq))
      }
    } finally {
      await sql.close()
    }
  }

  export function trigger() {
    if (!enabled()) return
    if (state.run) return
    state.run = (async () => {
      try {
        await flush()
      } catch (err) {
        log.warn("sync flush failed", { err })
      } finally {
        state.run = undefined
      }
    })()
  }

  export async function start() {
    if (!enabled()) return
    try {
      await replay()
      await flush()
    } catch (err) {
      log.warn("sync startup failed", { err })
    }
  }
}
