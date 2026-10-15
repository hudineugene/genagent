CREATE TABLE `knowledge_gaps` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`client_id` text NOT NULL,
	`question` text NOT NULL,
	`missing` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`examples` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_gaps_agent_idx` ON `knowledge_gaps` (`agent_id`,`status`);