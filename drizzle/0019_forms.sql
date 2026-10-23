CREATE TABLE `client_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`kind` text DEFAULT 'form' NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`thanks` text DEFAULT '' NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_forms_client_idx` ON `client_forms` (`client_id`);
--> statement-breakpoint
CREATE TABLE `form_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`client_id` text NOT NULL,
	`agent_id` text,
	`conversation_id` text,
	`answers` text DEFAULT '{}' NOT NULL,
	`score` integer,
	`max_score` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `client_forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `form_responses_form_idx` ON `form_responses` (`form_id`,`created_at`);
