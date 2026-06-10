CREATE TABLE `approvals` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`actor` text,
	`expires_at` text NOT NULL,
	`decided_at` text,
	CONSTRAINT "approvals_state_check" CHECK("approvals"."state" IN ('waiting','approved','denied','expired'))
);
--> statement-breakpoint
CREATE INDEX `approvals_state_idx` ON `approvals` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`blueprint_id` text NOT NULL,
	`outcome` text NOT NULL,
	`impulse` text NOT NULL,
	`guard_block_reason` text,
	`resolution_of` text,
	`correlation_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "decisions_outcome_check" CHECK("decisions"."outcome" IN ('ignored','matched','blocked','fired','denied','expired'))
);
--> statement-breakpoint
CREATE INDEX `decisions_blueprint_idx` ON `decisions` (`blueprint_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `fired_events` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`subject` text NOT NULL,
	`published_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fired_correlation_idx` ON `fired_events` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `guard_state` (
	`blueprint_id` text PRIMARY KEY NOT NULL,
	`cooldown_until` text,
	`run_lock_holder` text,
	`run_lock_since` text,
	`buffered_impulse` text,
	`buffered_by_decision_id` text
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text NOT NULL,
	`blueprint_id` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`blueprint_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_expiry_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ignored_counters` (
	`blueprint_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`blueprint_id`, `day`)
);
