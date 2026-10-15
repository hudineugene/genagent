CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`scenario_id` text,
	`scenario_name` text NOT NULL,
	`transcript` text NOT NULL,
	`verdicts` text NOT NULL,
	`score` real,
	`passed` integer DEFAULT false NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`error` text,
	`cost` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_results_run_idx` ON `test_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`score` real,
	`cost` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_runs_agent_idx` ON `test_runs` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'script' NOT NULL,
	`turns` text NOT NULL,
	`persona` text DEFAULT '' NOT NULL,
	`max_turns` integer DEFAULT 4 NOT NULL,
	`criteria` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_scenarios_agent_idx` ON `test_scenarios` (`agent_id`);--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`client_id` text,
	`agent_id` text,
	`conversation_id` text,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real,
	`ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_agent_idx` ON `usage_log` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_created_idx` ON `usage_log` (`created_at`);