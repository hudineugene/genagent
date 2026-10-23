CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`agent_id` text,
	`conversation_id` text,
	`number` integer DEFAULT 0 NOT NULL,
	`requester` text DEFAULT '' NOT NULL,
	`subject` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`amount` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text DEFAULT '' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `approvals_client_idx` ON `approvals` (`client_id`,`created_at`);
