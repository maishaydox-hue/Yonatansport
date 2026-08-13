-- Run this once in Supabase: Project -> SQL Editor -> New query -> paste -> Run

create extension if not exists "pgcrypto";

create table if not exists weekly_entries (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('csv', 'image', 'manual')),
  file_name text,
  top_speed numeric,
  sprints numeric,
  hid numeric,
  very_fast_run numeric,
  fast_run numeric,
  distance_per_min numeric,
  total_distance numeric,
  time_value text,
  image_path text,          -- path inside the 'weekly-images' storage bucket
  image_url text,           -- public URL, cached at insert time
  related_image_id uuid references weekly_entries(id) on delete set null,
  raw_source text,          -- original CSV text or OCR text, kept for debugging/re-checking
  created_at timestamptz not null default now()
);

create index if not exists weekly_entries_created_at_idx on weekly_entries (created_at desc);

-- Storage bucket for uploaded stat-screenshot images.
-- Easiest: Supabase Dashboard -> Storage -> New bucket -> name it "weekly-images" -> Public bucket: ON.
-- (You can also create it via SQL, but the dashboard is simpler and less error-prone.)
