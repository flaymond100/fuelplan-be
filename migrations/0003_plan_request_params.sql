-- 0003_plan_request_params.sql
-- Adds request_params jsonb column to plans and an atomic RPC function that
-- inserts a plan row and decrements the caller's credit in one transaction.
--
-- Apply via Supabase SQL editor (run as the postgres role) or `supabase db push`.

-- ============================================================================
-- plans — add request_params column
-- ============================================================================
alter table public.plans
  add column if not exists request_params jsonb not null default '{}';


-- ============================================================================
-- insert_plan_and_decrement_credit
-- Called by the backend (service role) after Claude returns a valid plan.
-- Inserts the plan row and decrements the appropriate credit counter
-- atomically so a concurrent request cannot double-consume the same credit.
--
-- Returns the inserted plan row as jsonb.
-- Raises an exception with code 'INSUFFICIENT_CREDITS' if a pay_per_plan
-- user has no credits left (should not happen if checkAccess ran, but
-- guards against race conditions).
-- ============================================================================
create or replace function public.insert_plan_and_decrement_credit(
  p_plan_id        uuid,
  p_user_id        uuid,
  p_race_name      text,
  p_race_date      date,
  p_distance_km    numeric,
  p_elevation_m    integer,
  p_start_time     time,
  p_gpx_file_path  text,
  p_plan_json      jsonb,
  p_request_params jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_row   jsonb;
  v_sub_plan   text;
  v_rows_updated integer;
begin
  -- Insert the plan
  insert into public.plans (
    id, user_id, race_name, race_date, distance_km, elevation_m,
    start_time, gpx_file_path, plan_json, request_params
  ) values (
    p_plan_id, p_user_id, p_race_name, p_race_date, p_distance_km, p_elevation_m,
    p_start_time, p_gpx_file_path, p_plan_json, p_request_params
  )
  returning to_jsonb(public.plans.*) into v_plan_row;

  -- Lock the subscription row to prevent concurrent requests racing through
  -- the same credit check at the same moment.
  select plan into v_sub_plan
  from public.subscriptions
  where user_id = p_user_id
  for update;

  if v_sub_plan = 'pay_per_plan' then
    update public.plan_credits
    set credits = credits - 1,
        updated_at = now()
    where user_id = p_user_id
      and credits > 0;

    get diagnostics v_rows_updated = row_count;
    if v_rows_updated = 0 then
      raise exception 'INSUFFICIENT_CREDITS' using errcode = 'P0001';
    end if;

  elsif v_sub_plan = 'free' or v_sub_plan is null then
    update public.plan_credits
    set used_this_month = used_this_month + 1,
        updated_at = now()
    where user_id = p_user_id;
  end if;
  -- pro: no credit action needed

  return v_plan_row;
end;
$$;

-- Grant execute to service role only (anon/authenticated cannot call this)
revoke execute on function public.insert_plan_and_decrement_credit(
  uuid, uuid, text, date, numeric, integer, time, text, jsonb, jsonb
) from public, anon, authenticated;
