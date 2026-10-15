CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`client_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channels_agent_idx` ON `channels` (`agent_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`external_id` text NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`contact_handle` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'ai' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`needs_attention` integer DEFAULT false NOT NULL,
	`unread` integer DEFAULT 0 NOT NULL,
	`last_message_text` text DEFAULT '' NOT NULL,
	`last_message_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_channel_external_idx` ON `conversations` (`channel_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `conversations_last_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`author_id` text,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);