ALTER TABLE `users` ADD `session_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer DEFAULT 0 NOT NULL;
