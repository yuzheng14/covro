CREATE TABLE `turn_completion_reads` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`)
);
