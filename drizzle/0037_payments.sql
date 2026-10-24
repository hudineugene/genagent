CREATE TABLE `client_payments` (
	`client_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`credentials` text DEFAULT '{}' NOT NULL,
	`currency` text DEFAULT 'UAH' NOT NULL,
	`max_amount` real,
	`paid_text` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`conversation_id` text,
	`agent_id` text,
	`provider` text NOT NULL,
	`order_id` text NOT NULL,
	`external_id` text,
	`amount` real NOT NULL,
	`currency` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`url` text NOT NULL,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_order_idx` ON `payments` (`order_id`);
--> statement-breakpoint
CREATE INDEX `payments_client_idx` ON `payments` (`client_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `payments_conv_idx` ON `payments` (`conversation_id`);
