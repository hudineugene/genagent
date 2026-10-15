CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`client_id` text NOT NULL,
	`conversation_id` text,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_link` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`service` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `bookings_agent_idx` ON `bookings` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bookings_client_idx` ON `bookings` (`client_id`,`created_at`);