CREATE TABLE `client_doc_types` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_doc_types_client_idx` ON `client_doc_types` (`client_id`);
--> statement-breakpoint
CREATE TABLE `client_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`doc_type_id` text,
	`conversation_id` text,
	`message_id` text,
	`filename` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_type_id`) REFERENCES `client_doc_types`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `client_documents_client_idx` ON `client_documents` (`client_id`,`created_at`);
