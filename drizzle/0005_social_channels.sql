CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `kind` text DEFAULT 'dm' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `context` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `status` text DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `external_id` text;--> statement-breakpoint
CREATE INDEX `messages_external_idx` ON `messages` (`external_id`);