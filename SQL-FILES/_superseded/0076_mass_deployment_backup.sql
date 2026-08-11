CREATE TABLE IF NOT EXISTS deployment_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version text NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'prepared',
  manifest jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployment_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  backup_type varchar(100) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'recorded',
  created_at timestamptz DEFAULT now()
);
