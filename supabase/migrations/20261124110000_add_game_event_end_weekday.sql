ALTER TABLE public.nowa_game_events
ADD COLUMN IF NOT EXISTS end_weekday smallint;

COMMENT ON COLUMN public.nowa_game_events.end_weekday IS
'Optional weekday (0=Sunday..6=Saturday) for special-event end time; NULL keeps legacy end-time calculation.';
