CREATE TABLE `kb_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`client_id` text NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `kb_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `kb_chunks_source_idx` ON `kb_chunks` (`source_id`);--> statement-breakpoint
CREATE TABLE `kb_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`crawl` text,
	`filename` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`error` text,
	`content` text DEFAULT '' NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`chunks` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `kb_sources_client_idx` ON `kb_sources` (`client_id`);