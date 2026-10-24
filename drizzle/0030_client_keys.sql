ALTER TABLE `clients` ADD `api_keys` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `usage_log` ADD `own_key` integer DEFAULT false NOT NULL;
