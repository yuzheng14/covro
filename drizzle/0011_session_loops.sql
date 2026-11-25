CREATE TABLE `session_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_key` text NOT NULL,
	`settings` text NOT NULL,
	`prompt` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`version` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`max_runs` integer NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_started_at` integer,
	`last_result` text,
	`last_turn_id` text,
	`last_operation_id` text,
	FOREIGN KEY (`id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_operation_id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_loops_thread_idx` ON `session_loops` (`thread_id`);--> statement-breakpoint
CREATE INDEX `session_loops_due_idx` ON `session_loops` (`status`,`next_run_at`);