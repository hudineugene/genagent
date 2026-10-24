CREATE TABLE `client_billing` (
	`client_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`usd_rate` real DEFAULT 1 NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`markup_pct` real DEFAULT 0 NOT NULL,
	`channel_markup_pct` real DEFAULT 0 NOT NULL,
	`included_usd` real DEFAULT 0 NOT NULL,
	`limit_usd` real,
	`alerted` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
