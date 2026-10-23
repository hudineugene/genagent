CREATE TABLE `client_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`url` text NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`params` text DEFAULT '[]' NOT NULL,
	`read_only` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_tools_client_idx` ON `client_tools` (`client_id`);
