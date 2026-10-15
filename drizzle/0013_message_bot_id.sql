ALTER TABLE `messages` ADD `bot_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_bot_idx` ON `messages` (`conversation_id`,`bot_id`);
