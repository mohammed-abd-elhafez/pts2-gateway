-- Go-live time of a tank: readings stamped before it are never sent (they are set aside as 'before_start').
-- A controller that starts uploading sends everything it has stored (months of records); without this the whole
-- backlog would be chained and sent. NULL: no cutoff, as before.
ALTER TABLE tanks ADD COLUMN send_from timestamptz;
