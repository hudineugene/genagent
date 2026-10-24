CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`table_id` text,
	`kind` text DEFAULT 'date' NOT NULL,
	`date_column` text DEFAULT '' NOT NULL,
	`offset_days` integer DEFAULT 1 NOT NULL,
	`key_column` text DEFAULT '' NOT NULL,
	`status_column` text DEFAULT '' NOT NULL,
	`status_values` text DEFAULT '[]' NOT NULL,
	`contact_column` text DEFAULT '' NOT NULL,
	`channel_id` text,
	`message` text DEFAULT '' NOT NULL,
	`hour` integer DEFAULT 10 NOT NULL,
	`notify_team` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`last_result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `data_tables`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reminders_client_idx` ON `reminders` (`client_id`);
--> statement-breakpoint
CREATE TABLE `reminder_log` (
	`id` text PRIMARY KEY NOT NULL,
	`reminder_id` text NOT NULL,
	`row_key` text NOT NULL,
	`value` text NOT NULL,
	`status` text NOT NULL,
	`contact` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_log_unique` ON `reminder_log` (`reminder_id`,`row_key`,`value`);
--> statement-breakpoint
CREATE TABLE `onboarding_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`welcome` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `onboarding_plans_client_idx` ON `onboarding_plans` (`client_id`);
--> statement-breakpoint
CREATE TABLE `onboardings` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`plan_id` text,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`contact` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`channel_id` text,
	`start_date` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`welcome_text` text DEFAULT '' NOT NULL,
	`welcome_status` text DEFAULT 'pending' NOT NULL,
	`last_tick` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `onboarding_plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `onboardings_client_idx` ON `onboardings` (`client_id`,`status`);
--> statement-breakpoint
CREATE TABLE `vacancies` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`title` text NOT NULL,
	`requirements` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vacancies_client_idx` ON `vacancies` (`client_id`);
--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`vacancy_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`contact` text DEFAULT '' NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`score` integer,
	`verdict` text,
	`summary` text DEFAULT '' NOT NULL,
	`strengths` text DEFAULT '[]' NOT NULL,
	`gaps` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `candidates_vacancy_idx` ON `candidates` (`vacancy_id`);
--> statement-breakpoint
CREATE TABLE `client_repeat` (
	`client_id` text PRIMARY KEY NOT NULL,
	`table_id` text,
	`customer_column` text DEFAULT '' NOT NULL,
	`date_column` text DEFAULT '' NOT NULL,
	`contact_column` text DEFAULT '' NOT NULL,
	`product_column` text DEFAULT '' NOT NULL,
	`amount_column` text DEFAULT '' NOT NULL,
	`lead_days` integer DEFAULT 3 NOT NULL,
	`min_orders` integer DEFAULT 2 NOT NULL,
	`auto` integer DEFAULT false NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`channel_id` text,
	`hour` integer DEFAULT 11 NOT NULL,
	`last_run_at` integer,
	`last_result` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `data_tables`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `repeat_nudges` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`customer` text NOT NULL,
	`last_order` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repeat_nudges_unique` ON `repeat_nudges` (`client_id`,`customer`,`last_order`);
--> statement-breakpoint
ALTER TABLE `loyalty_programs` ADD `peer_allowance` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `loyalty_tx` ADD `giver_id` text;
--> statement-breakpoint
ALTER TABLE `client_doc_types` ADD `folder` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_doc_types` ADD `name_template` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_documents` ADD `title` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_documents` ADD `folder` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_documents` ADD `file` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_documents` ADD `size` integer DEFAULT 0 NOT NULL;
