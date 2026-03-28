import { MessageTable, PartTable } from "@/session/session.sql"
import { Database, and, eq, inArray, sql } from "@/storage/db"
import type { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"

export namespace SessionRecover {
  const log = Log.create({ service: "session.recover" })

  const aborted = {
    name: "MessageAbortedError",
    data: {
      message: "The operation was aborted.",
    },
  } as const

  export async function run() {
    const msgs = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant' and json_type(${MessageTable.data}, '$.time.completed') is null`,
        )
        .all(),
    )
    if (msgs.length === 0) return { messages: 0, parts: 0 }

    const ids = msgs.map((row) => row.id)
    const parts = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(
          and(
            inArray(PartTable.message_id, ids),
            sql`json_extract(${PartTable.data}, '$.type') = 'tool' and json_extract(${PartTable.data}, '$.state.status') in ('pending', 'running')`,
          ),
        )
        .all(),
    )

    const time = Date.now()
    Database.transaction((db) => {
      msgs.forEach((row) => {
        const data = row.data as MessageV2.Assistant
        db.update(MessageTable)
          .set({
            data: {
              ...data,
              time: {
                ...data.time,
                completed: Math.max(data.time.created, time),
              },
              error: data.error ?? aborted,
            } as (typeof MessageTable.$inferInsert)["data"],
          })
          .where(eq(MessageTable.id, row.id))
          .run()
      })

      parts.forEach((row) => {
        const data = row.data as MessageV2.ToolPart
        const start = data.state.status === "running" ? data.state.time.start : time
        db.update(PartTable)
          .set({
            data: {
              ...data,
              state: {
                status: "error",
                input: data.state.input,
                error: "Tool execution aborted",
                time: {
                  start,
                  end: Math.max(start, time),
                },
              },
            } as (typeof PartTable.$inferInsert)["data"],
          })
          .where(and(eq(PartTable.id, row.id), eq(PartTable.message_id, row.message_id)))
          .run()
      })
    })

    log.info("recovered stale session state", {
      messages: msgs.length,
      parts: parts.length,
    })
    return { messages: msgs.length, parts: parts.length }
  }
}
