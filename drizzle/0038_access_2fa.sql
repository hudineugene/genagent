ALTER TABLE `users` ADD `totp_secret` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `recovery_codes` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `client_ids` text;
