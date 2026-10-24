CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`vehicle` text DEFAULT '' NOT NULL,
	`driver` text DEFAULT '' NOT NULL,
	`driver_name` text DEFAULT '' NOT NULL,
	`departure` integer NOT NULL,
	`return_to_base` integer DEFAULT true NOT NULL,
	`stops` text DEFAULT '[]' NOT NULL,
	`km` real DEFAULT 0 NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	`maps_url` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`notify_customers` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`risk` text DEFAULT '' NOT NULL,
	`sent_at` integer,
	`last_check_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trips_client_idx` ON `trips` (`client_id`,`status`);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'http' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`expect_text` text DEFAULT '' NOT NULL,
	`max_ms` integer DEFAULT 10000 NOT NULL,
	`interval_min` integer DEFAULT 5 NOT NULL,
	`fail_threshold` integer DEFAULT 2 NOT NULL,
	`api_key` text NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`fails` integer DEFAULT 0 NOT NULL,
	`last_check_at` integer,
	`last_ms` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitors_client_idx` ON `monitors` (`client_id`);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`client_id` text NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`draft` text DEFAULT '' NOT NULL,
	`resolved_draft` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`campaign_id` text,
	`started_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `incidents_monitor_idx` ON `incidents` (`monitor_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`level` text DEFAULT 'beginner' NOT NULL,
	`topics` text DEFAULT '' NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`program_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`program_id`) REFERENCES `loyalty_programs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `courses_client_idx` ON `courses` (`client_id`);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`video_url` text DEFAULT '' NOT NULL,
	`quiz` text DEFAULT '[]' NOT NULL,
	`pass_score` integer DEFAULT 70 NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lessons_course_idx` ON `lessons` (`course_id`,`position`);
--> statement-breakpoint
CREATE TABLE `learners` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`contact` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`conversation_id` text,
	`level` text DEFAULT '' NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '[]' NOT NULL,
	`results` text DEFAULT '{}' NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`last_activity_at` integer,
	`reminded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learners_contact_idx` ON `learners` (`client_id`,`contact`);
