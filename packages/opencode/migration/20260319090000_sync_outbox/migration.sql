CREATE TABLE `sync_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `data` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_sent` integer
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text,
  `time_updated` integer NOT NULL
);
