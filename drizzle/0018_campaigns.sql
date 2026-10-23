CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`enabled_at` integer,
	`segment` text DEFAULT '{}' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`trigger` text,
	`schedule_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaigns_client_idx` ON `campaigns` (`client_id`);
--> statement-breakpoint
CREATE TABLE `campaign_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` integer NOT NULL,
	`enrolled_at` integer NOT NULL,
	`sent_at` integer,
	`message_id` text,
	`error` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_runs_unique` ON `campaign_runs` (`campaign_id`,`conversation_id`);
--> statement-breakpoint
CREATE INDEX `campaign_runs_due_idx` ON `campaign_runs` (`status`,`due_at`);
