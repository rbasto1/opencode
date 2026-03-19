import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const SyncOutboxTable = sqliteTable("sync_outbox", {
  id: text().primaryKey(),
  kind: text().notNull(),
  data: text({ mode: "json" }).notNull(),
  time_created: integer().notNull(),
  time_sent: integer(),
})

export const SyncStateTable = sqliteTable("sync_state", {
  key: text().primaryKey(),
  value: text({ mode: "json" }),
  time_updated: integer().notNull(),
})
