-- Legacy reservations remain unbound and cannot be adopted by a durable run.
ALTER TABLE comic_text_operations ADD COLUMN operation_id text REFERENCES operations(id);
