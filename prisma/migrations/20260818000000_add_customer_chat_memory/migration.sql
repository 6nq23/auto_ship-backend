CREATE TABLE IF NOT EXISTS public.wa_customer_memory (
  phone TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  last_intent TEXT,
  last_order_number TEXT,
  active_ticket_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS name_source TEXT;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS shopify_customer_id TEXT;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS current_issue TEXT;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS known_order_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS issue_history JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS archive_summary TEXT;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS archived_through_message_id BIGINT;
ALTER TABLE public.wa_customer_memory ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.wa_customer_memory SET known_order_numbers = '[]'::jsonb WHERE known_order_numbers IS NULL;
UPDATE public.wa_customer_memory SET issue_history = '[]'::jsonb WHERE issue_history IS NULL;
UPDATE public.wa_customer_memory SET profile = '{}'::jsonb WHERE profile IS NULL;

CREATE INDEX IF NOT EXISTS wa_customer_memory_updated_idx ON public.wa_customer_memory (updated_at DESC);
