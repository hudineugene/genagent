CREATE TABLE `contact_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'file' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_lists_client_idx` ON `contact_lists` (`client_id`);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`telegram` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`grp` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`unsubscribed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `contact_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_list_idx` ON `contacts` (`list_id`);
--> statement-breakpoint
CREATE INDEX `contacts_email_idx` ON `contacts` (`client_id`,`email`);
--> statement-breakpoint
CREATE TABLE `outreach` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'email' NOT NULL,
	`channel_id` text,
	`brief` text DEFAULT '' NOT NULL,
	`group_briefs` text DEFAULT '{}' NOT NULL,
	`research` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `contact_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `outreach_client_idx` ON `outreach` (`client_id`);
--> statement-breakpoint
CREATE TABLE `outreach_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`outreach_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`research` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`outreach_id`) REFERENCES `outreach`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outreach_messages_idx` ON `outreach_messages` (`outreach_id`,`status`);
