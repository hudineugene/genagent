CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`task` text NOT NULL,
	`schedule` text DEFAULT '{}' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`delivery` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routines_client_idx` ON `routines` (`client_id`);
