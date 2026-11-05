CREATE TABLE `pending_user_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`item` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pending_user_messages_status_check" CHECK("pending_user_messages"."status" in ('submitting', 'submitted', 'unknown', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `pending_user_messages_thread_idx` ON `pending_user_messages` (`thread_id`);