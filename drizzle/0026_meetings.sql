CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'protocol' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`transcript` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`tasks` text DEFAULT '[]' NOT NULL,
	`score` integer,
	`status` text DEFAULT 'processing' NOT NULL,
	`error` text,
	`delivery` text DEFAULT '{"team":false,"owners":false}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meetings_client_idx` ON `meetings` (`client_id`,`created_at`);
