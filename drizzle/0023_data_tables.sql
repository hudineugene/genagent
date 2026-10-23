CREATE TABLE `data_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'file' NOT NULL,
	`sheet_url` text DEFAULT '' NOT NULL,
	`sheet_name` text DEFAULT '' NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`columns` text DEFAULT '[]' NOT NULL,
	`rows` text DEFAULT '[]' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`refreshed_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_tables_client_idx` ON `data_tables` (`client_id`);
