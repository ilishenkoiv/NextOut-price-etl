-- Checkpoint for the strictly low-priority roulette price revalidator.
-- It never changes the immutable roulette pool: it merely remembers the last exact ticket
-- successfully considered so a preempted run continues in the next idle window.
create table if not exists public.roulette_price_refresh_checkpoint (
  singleton boolean primary key default true check (singleton),
  snapshot_at timestamptz not null,
  cursor_key text,
  updated_at timestamptz not null default now()
);

alter table public.roulette_price_refresh_checkpoint enable row level security;
revoke all on table public.roulette_price_refresh_checkpoint from anon, authenticated;
grant select, insert, update, delete on table public.roulette_price_refresh_checkpoint to service_role;

comment on table public.roulette_price_refresh_checkpoint is
  'Service-only resumable cursor for the priority-0 roulette price recheck. No pool membership or ranking is stored here.';

notify pgrst, 'reload schema';
