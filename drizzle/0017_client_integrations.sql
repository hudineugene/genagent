CREATE TABLE `client_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_integrations_client_idx` ON `client_integrations` (`client_id`);
--> statement-breakpoint
ALTER TABLE `client_tools` ADD `kind` text DEFAULT 'http' NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_tools` ADD `sheet` text;
