ALTER TABLE `kb_sources` ADD `external_key` text;--> statement-breakpoint
CREATE INDEX `kb_sources_external_idx` ON `kb_sources` (`client_id`,`external_key`);