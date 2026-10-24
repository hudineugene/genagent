ALTER TABLE `conversations` ADD `assignee_id` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `conversations` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `snoozed_at` integer;--> statement-breakpoint
CREATE TABLE `conversation_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `conversation_notes_conv_idx` ON `conversation_notes` (`conversation_id`,`created_at`);
