CREATE TABLE IF NOT EXISTS security_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  batch_key varchar(20) NOT NULL,
  title text NOT NULL,
  category varchar(100) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'todo',
  created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, batch_key)
);
