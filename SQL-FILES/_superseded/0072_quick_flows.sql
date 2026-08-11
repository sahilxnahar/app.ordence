CREATE TABLE IF NOT EXISTS flow_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES users(id),
  flow_type varchar(100) NOT NULL,
  title text NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'submitted',
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
