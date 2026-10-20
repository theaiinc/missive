-- From Sep 25, 2026 the organizer read every new message as "other" and
-- archived it (organizer.service.ts parsed the model's answers wrongly), so
-- nothing new stayed in anyone's Inbox. Mail it archived that way goes back
-- to the Inbox with its label cleared; the fixed organizer labels it again,
-- archiving only what really is a newsletter. Mail a rule or the person filed
-- is left where it is. Runs once (the migration runner records it).
UPDATE missives
   SET folder = 'inbox', classification = NULL, updated_at = NOW()
 WHERE direction = 'inbound'
   AND folder = 'archived'
   AND classification IN ('other', 'meeting')
   AND filed_by_user_at IS NULL
   AND ruled_at IS NULL
   AND received_at >= '2026-09-25';
