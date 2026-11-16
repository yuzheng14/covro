CREATE TABLE `background_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`snapshot` text
);
