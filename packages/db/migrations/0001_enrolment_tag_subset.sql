-- An enrolment's capability tags are chosen from the event's own set (FR-009).
-- A check constraint cannot read another table, so the rule is a trigger: it
-- belongs in the database because a rule enforced only in a route handler is a
-- rule the next route handler forgets. The error code is the one PostgreSQL
-- uses for a violated check, so callers classify it without matching text.
create function enrolment_tags_within_event() returns trigger as $$
begin
  if not (new.tags <@ (select capability_tags from event where id = new.event_id)) then
    raise exception 'Enrolment tags must be drawn from the event capability tags'
      using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
--> statement-breakpoint
create trigger enrolment_tags_within_event
before insert or update on enrolment
for each row execute function enrolment_tags_within_event();
