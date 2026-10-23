CREATE TABLE `client_logistics` (
	`client_id` text PRIMARY KEY NOT NULL,
	`base_address` text DEFAULT '' NOT NULL,
	`stop_minutes` integer DEFAULT 10 NOT NULL,
	`vehicles` text DEFAULT '[]' NOT NULL,
	`delivery_note` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
