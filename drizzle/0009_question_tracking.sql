CREATE TABLE `question_action_history` (
	`action_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`action` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `question_action_history_thread` ON `question_action_history` (`thread_id`);--> statement-breakpoint
CREATE TABLE `question_tracking` (
	`thread_id` text NOT NULL,
	`question_id` text NOT NULL,
	`state` text NOT NULL,
	`operation_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `question_id`)
);
