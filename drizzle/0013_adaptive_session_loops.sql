CREATE TABLE `__new_session_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_key` text NOT NULL,
	`settings` text NOT NULL,
	`prompt` text NOT NULL,
	`mode` text DEFAULT 'fixed' NOT NULL,
	`interval_ms` integer,
	`status` text NOT NULL,
	`reason` text,
	`version` integer DEFAULT 0 NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer,
	`run_version` integer,
	`last_decision` text,
	`last_started_at` integer,
	`last_result` text,
	`last_turn_id` text,
	`last_operation_id` text,
	FOREIGN KEY (`id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_operation_id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_session_loops`("id", "thread_id", "workspace_key", "settings", "prompt", "interval_ms", "status", "reason", "version", "runs", "next_run_at", "last_started_at", "last_result", "last_turn_id", "last_operation_id") SELECT "id", "thread_id", "workspace_key", "settings", "prompt", "interval_ms", "status", "reason", "version", "runs", "next_run_at", "last_started_at", "last_result", "last_turn_id", "last_operation_id" FROM `session_loops`;--> statement-breakpoint
DROP TABLE `session_loops`;--> statement-breakpoint
ALTER TABLE `__new_session_loops` RENAME TO `session_loops`;--> statement-breakpoint
CREATE INDEX `session_loops_thread_idx` ON `session_loops` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_loops_run_idx` ON `session_loops` (`last_operation_id`);--> statement-breakpoint
CREATE INDEX `session_loops_due_idx` ON `session_loops` (`status`,`next_run_at`);