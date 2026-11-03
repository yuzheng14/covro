CREATE TABLE `turn_token_totals` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`total_tokens` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`)
);
