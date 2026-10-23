CREATE TABLE `loyalty_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text DEFAULT 'Бонусы' NOT NULL,
	`unit` text DEFAULT 'баллов' NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`rewards` text DEFAULT '[]' NOT NULL,
	`welcome` integer DEFAULT 0 NOT NULL,
	`notify_customer` integer DEFAULT true NOT NULL,
	`api_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loyalty_programs_client_idx` ON `loyalty_programs` (`client_id`);
--> statement-breakpoint
CREATE TABLE `loyalty_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`contact` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`conversation_id` text,
	`balance` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `loyalty_programs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_accounts_contact_idx` ON `loyalty_accounts` (`program_id`,`contact`);
--> statement-breakpoint
CREATE TABLE `loyalty_tx` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`delta` integer NOT NULL,
	`balance` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'studio' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `loyalty_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loyalty_tx_account_idx` ON `loyalty_tx` (`account_id`,`created_at`);
