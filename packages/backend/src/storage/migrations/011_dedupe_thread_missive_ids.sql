-- Gmail and IMAP sync used to re-fetch every plain-text message on each run
-- and push its id onto its thread again, so missive_ids gathered duplicates
-- and message_count grew with every sync. Keep each id once, in first-seen
-- order, and recount. Only threads that actually have duplicates change.
--
-- threads has FORCE ROW LEVEL SECURITY, so even the owner sees only the rows
-- of the user in app.user_id: repair one user at a time.
DO $$
DECLARE
  u RECORD;
BEGIN
  FOR u IN SELECT id FROM users LOOP
    PERFORM set_config('app.user_id', u.id::text, true);
    UPDATE threads
       SET missive_ids   = deduped.ids,
           message_count = cardinality(deduped.ids),
           updated_at    = NOW()
      FROM (
        SELECT t.id,
               ARRAY(
                 SELECT x
                   FROM (SELECT x, min(n) AS first_seen
                           FROM unnest(t.missive_ids) WITH ORDINALITY AS q(x, n)
                          GROUP BY x) firsts
                  ORDER BY first_seen
               ) AS ids
          FROM threads t
      ) AS deduped
     WHERE threads.id = deduped.id
       AND cardinality(threads.missive_ids) <> cardinality(deduped.ids);
  END LOOP;
  PERFORM set_config('app.user_id', '', true);
END $$;
