CREATE TABLE `client_pricing` (
	`client_id` text PRIMARY KEY NOT NULL,
	`table_id` text,
	`name_column` text DEFAULT '' NOT NULL,
	`price_column` text DEFAULT '' NOT NULL,
	`tier_by` text DEFAULT 'amount' NOT NULL,
	`tiers` text DEFAULT '[]' NOT NULL,
	`vat` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT '€' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `data_tables`(`id`) ON UPDATE no action ON DELETE set null
);
