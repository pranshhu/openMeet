-- All timestamps are epoch milliseconds.
UPDATE recordings SET started_at = started_at * 1000 WHERE started_at < 100000000000;
UPDATE recordings SET finalized_at = finalized_at * 1000 WHERE finalized_at IS NOT NULL AND finalized_at < 100000000000;
