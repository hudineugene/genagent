CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`batch` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'post' NOT NULL,
	`platform` text DEFAULT 'telegram' NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`channel_id` text,
	`target` text DEFAULT '' NOT NULL,
	`publish_at` integer,
	`published_at` integer,
	`url` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `content_items_client_idx` ON `content_items` (`client_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `content_items_due_idx` ON `content_items` (`status`,`publish_at`);
