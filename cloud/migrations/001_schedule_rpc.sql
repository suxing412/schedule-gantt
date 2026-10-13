-- WorkBuddy / PostgreSQL 17. Execute through the administrator migration channel.
-- This file creates a private data store and five deliberately narrow public RPCs.
-- No application service-role credential or browser-readable password hash is used.
-- Re-run with the SAME administrator role. Existing project data is preserved.
-- Apply to this application's dedicated database/environment. If this database
-- also serves other applications, an administrator must review pgcrypto grants
-- before applying: anonymous raw crypto RPCs are revoked below. Existing explicit
-- role grants are preserved; service_role and the migration owner are granted use.
-- Gateway prerequisite: PostgREST must use commit transactions, never a rollback
-- default/override. We also reject Prefer: tx=rollback, but SQL cannot commit an
-- outer transaction. Database request budgets are not network / DDoS protection.

BEGIN;

DO $migration$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Run this migration using the administrator migration channel';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Expected WorkBuddy roles anon and authenticated';
  END IF;
END
$migration$;

CREATE SCHEMA IF NOT EXISTS schedule_private;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA schedule_private;
REVOKE ALL ON SCHEMA schedule_private FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA schedule_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA schedule_private REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS schedule_private.projects (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{32}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  project jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(project) = 'object'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_by text NOT NULL CHECK (pg_catalog.char_length(updated_by) BETWEEN 1 AND 64),
  edit_code_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_private.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  project_id text NOT NULL REFERENCES schedule_private.projects(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (pg_catalog.char_length(display_name) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_sessions_project_expiry ON schedule_private.sessions(project_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS schedule_sessions_expiry ON schedule_private.sessions(expires_at);

-- Only two global keys plus at most one key per existing project; callers cannot
-- choose arbitrary bucket names or multiply their allowance with new client IDs.
CREATE TABLE IF NOT EXISTS schedule_private.request_budgets (
  budget_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);

ALTER TABLE schedule_private.projects OWNER TO CURRENT_USER;
ALTER TABLE schedule_private.sessions OWNER TO CURRENT_USER;
ALTER TABLE schedule_private.request_budgets OWNER TO CURRENT_USER;
ALTER TABLE schedule_private.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_private.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_private.request_budgets ENABLE ROW LEVEL SECURITY;
-- The migration owner also owns the SECURITY DEFINER functions. Owner bypass is
-- intentional here; FORCE RLS without an owner policy would break these RPCs.
ALTER TABLE schedule_private.projects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_private.sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_private.request_budgets NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA schedule_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA schedule_private FROM PUBLIC, anon, authenticated;

-- pgcrypto may already live in public or extensions. Resolve its actual schema
-- once during migration, then hard-code qualified references in private helpers.
DO $crypto$
DECLARE v_schema text;
BEGIN
  SELECT n.nspname INTO STRICT v_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgcrypto';
  EXECUTE pg_catalog.format($body$
    CREATE OR REPLACE FUNCTION schedule_private.hash_code(p_code text) RETURNS text
    LANGUAGE sql VOLATILE SET search_path = pg_catalog
    AS 'SELECT %1$I.crypt(p_code, %1$I.gen_salt(''bf'', 8))'
  $body$, v_schema);
  EXECUTE pg_catalog.format($body$
    CREATE OR REPLACE FUNCTION schedule_private.code_matches(p_code text, p_hash text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
    AS 'SELECT p_hash = %1$I.crypt(p_code, p_hash)'
  $body$, v_schema);
  EXECUTE pg_catalog.format($body$
    CREATE OR REPLACE FUNCTION schedule_private.new_token() RETURNS text
    LANGUAGE sql VOLATILE SET search_path = pg_catalog
    AS 'SELECT pg_catalog.encode(%1$I.gen_random_bytes(32), ''hex'')'
  $body$, v_schema);
  EXECUTE pg_catalog.format($body$
    CREATE OR REPLACE FUNCTION schedule_private.token_digest(p_token text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
    AS 'SELECT pg_catalog.encode(%1$I.digest(p_token, ''sha256''), ''hex'')'
  $body$, v_schema);
END
$crypto$;

-- Do not expose raw pgcrypto RPCs: otherwise callers could select an arbitrary
-- bcrypt work factor and bypass the narrow application hashing budgets. Existing
-- extensions are not moved; this permission tightening also applies if pgcrypto
-- was previously installed in public. Other apps sharing this database must use
-- their own trusted roles/functions, rather than anonymous direct crypto RPCs.
DO $crypto_acl$
DECLARE v_function record;
BEGIN
  FOR v_function IN SELECT p.oid::regprocedure AS identity FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid
    JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
    WHERE d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e' AND e.extname='pgcrypto'
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function.identity);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %I',v_function.identity,current_user);
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO service_role',v_function.identity);
    END IF;
    IF pg_catalog.has_function_privilege('anon',v_function.identity::oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated',v_function.identity::oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Cannot secure raw pgcrypto RPC %. Ask the database administrator to review function grants.',v_function.identity;
    END IF;
  END LOOP;
END
$crypto_acl$;

CREATE OR REPLACE FUNCTION schedule_private.failure(p_code text, p_message text, p_retry integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
  SELECT pg_catalog.jsonb_build_object('ok', false, 'error',
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('code', p_code, 'message', p_message, 'retryAfter', p_retry)))
$function$;

CREATE OR REPLACE FUNCTION schedule_private.public_record(p_row schedule_private.projects)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
  SELECT pg_catalog.jsonb_build_object('id', p_row.id, 'revision', p_row.revision,
    'project', p_row.project, 'createdAt', p_row.created_at, 'updatedAt', p_row.updated_at, 'updatedBy', p_row.updated_by)
$function$;

CREATE OR REPLACE FUNCTION schedule_private.rollback_requested()
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $function$
DECLARE v_headers jsonb;
BEGIN
  v_headers := COALESCE(NULLIF(pg_catalog.current_setting('request.headers', true), ''), '{}')::jsonb;
  RETURN COALESCE(v_headers ->> 'prefer', '') ~* '(^|,)\s*(tx\s*=\s*rollback|max-affected\s*=)'
    OR (COALESCE(v_headers ->> 'accept', 'application/json') NOT IN ('application/json', '*/*'));
END
$function$;

-- Returns 0 after reserving an attempt, or whole seconds until retry is allowed.
-- The row lock serializes reservation BEFORE password hashing across instances.
-- Failed authentication must RETURN normally; raising afterwards would roll back
-- this reservation. A caller-controlled outer rollback remains a gateway concern.
CREATE OR REPLACE FUNCTION schedule_private.reserve_budget(p_key text, p_limit integer, p_window integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
DECLARE v_row schedule_private.request_budgets; v_now timestamptz;
BEGIN
  INSERT INTO schedule_private.request_budgets(budget_key, window_start, attempts)
    VALUES (p_key, pg_catalog.clock_timestamp(), 0) ON CONFLICT (budget_key) DO NOTHING;
  SELECT * INTO STRICT v_row FROM schedule_private.request_budgets WHERE budget_key = p_key FOR UPDATE;
  v_now := pg_catalog.clock_timestamp();
  IF v_now >= v_row.window_start + pg_catalog.make_interval(secs => p_window) THEN
    UPDATE schedule_private.request_budgets SET window_start = v_now, attempts = 1 WHERE budget_key = p_key;
    RETURN 0;
  END IF;
  IF v_row.attempts >= p_limit THEN
    RETURN GREATEST(1, pg_catalog.ceil(EXTRACT(epoch FROM
      v_row.window_start + pg_catalog.make_interval(secs => p_window) - v_now))::integer);
  END IF;
  UPDATE schedule_private.request_budgets SET attempts = attempts + 1 WHERE budget_key = p_key;
  RETURN 0;
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.issue_session(p_id text, p_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
DECLARE v_token text; v_expiry timestamptz := pg_catalog.clock_timestamp() + interval '12 hours';
BEGIN
  -- Bounded opportunistic expiry cleanup; cap live sessions per board as well.
  DELETE FROM schedule_private.sessions WHERE token_hash IN
    (SELECT token_hash FROM schedule_private.sessions WHERE expires_at <= pg_catalog.clock_timestamp()
      ORDER BY expires_at LIMIT 128);
  DELETE FROM schedule_private.sessions WHERE token_hash IN
    (SELECT token_hash FROM schedule_private.sessions WHERE project_id = p_id
      ORDER BY expires_at DESC, token_hash OFFSET 49);
  v_token := schedule_private.new_token();
  INSERT INTO schedule_private.sessions(token_hash, project_id, display_name, expires_at)
    VALUES (schedule_private.token_digest(v_token), p_id, p_name, v_expiry);
  RETURN pg_catalog.jsonb_build_object('token', v_token, 'displayName', p_name, 'expiresAt', v_expiry);
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.valid_date(p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
DECLARE v_date date;
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR pg_catalog.substr(p_value, 1, 4)::integer < 100 THEN
    RETURN false;
  END IF;
  v_date := pg_catalog.make_date(pg_catalog.substr(p_value, 1, 4)::integer,
    pg_catalog.substr(p_value, 6, 2)::integer, pg_catalog.substr(p_value, 9, 2)::integer);
  RETURN true;
EXCEPTION WHEN datetime_field_overflow THEN RETURN false;
END
$function$;

-- Random temporary names, qualified accesses, bounded graph: no path explosion.
CREATE OR REPLACE FUNCTION schedule_private.validate_graph(p_tasks jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
DECLARE
  v_suffix text := pg_catalog.substr(schedule_private.new_token(), 1, 24);
  v_tasks text; v_edges text; v_nodes text; v_bad boolean; v_count integer; v_depth integer;
  v_ready integer[]; v_error text;
BEGIN
  v_tasks := 'schedule_tasks_' || v_suffix; v_edges := 'schedule_edges_' || v_suffix; v_nodes := 'schedule_nodes_' || v_suffix;
  EXECUTE pg_catalog.format('CREATE TEMP TABLE %I (id text PRIMARY KEY, pid text, kind text NOT NULL, n integer NOT NULL UNIQUE) ON COMMIT DROP', v_tasks);
  EXECUTE pg_catalog.format('CREATE TEMP TABLE %I (a integer NOT NULL, b integer NOT NULL, PRIMARY KEY(a,b)) ON COMMIT DROP', v_edges);
  EXECUTE pg_catalog.format('CREATE TEMP TABLE %I (n integer PRIMARY KEY, degree integer NOT NULL DEFAULT 0) ON COMMIT DROP', v_nodes);
  EXECUTE pg_catalog.format('INSERT INTO pg_temp.%I SELECT value->>''id'',value->>''pid'',value->>''type'',ordinality::integer*2 FROM pg_catalog.jsonb_array_elements($1) WITH ORDINALITY', v_tasks) USING p_tasks;
  EXECUTE pg_catalog.format('CREATE INDEX ON pg_temp.%I(pid)', v_tasks);
  EXECUTE pg_catalog.format('CREATE INDEX ON pg_temp.%I(b)', v_edges);
  EXECUTE pg_catalog.format('CREATE INDEX ON pg_temp.%I(degree)', v_nodes);
  EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM pg_temp.%1$I t LEFT JOIN pg_temp.%1$I p ON p.id=t.pid WHERE t.pid IS NOT NULL AND (p.id IS NULL OR p.kind=''milestone'' OR t.pid=t.id))', v_tasks) INTO v_bad;
  IF v_bad THEN v_error := '任务父级不存在、为节点或引用自身'; END IF;
  IF v_error IS NULL THEN
    EXECUTE pg_catalog.format('WITH RECURSIVE tree AS (SELECT id,1 AS depth FROM pg_temp.%1$I WHERE pid IS NULL UNION ALL SELECT t.id,p.depth+1 FROM pg_temp.%1$I t JOIN tree p ON t.pid=p.id WHERE p.depth<=128) SELECT count(*)::integer,COALESCE(max(depth),0) FROM tree', v_tasks) INTO v_count, v_depth;
    IF v_count <> pg_catalog.jsonb_array_length(p_tasks) OR v_depth > 128 THEN v_error := '任务父级存在循环或层级超过 128 层'; END IF;
  END IF;
  IF v_error IS NULL THEN
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements($1) t CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(t.value->''deps'') d LEFT JOIN pg_temp.%1$I target ON target.id=d.value WHERE target.id IS NULL OR target.id=t.value->>''id'' OR target.kind=''pipeline'' OR t.value->>''type''=''pipeline'')', v_tasks) INTO v_bad USING p_tasks;
    IF v_bad THEN v_error := '依赖不存在、引用自身或涉及管线'; END IF;
  END IF;
  IF v_error IS NULL THEN
    EXECUTE pg_catalog.format('WITH RECURSIVE ancestors AS (SELECT id,pid AS ancestor FROM pg_temp.%1$I WHERE pid IS NOT NULL UNION ALL SELECT a.id,t.pid FROM ancestors a JOIN pg_temp.%1$I t ON t.id=a.ancestor WHERE t.pid IS NOT NULL), deps AS (SELECT t.value->>''id'' AS id,d.value AS dep FROM pg_catalog.jsonb_array_elements($1) t CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(t.value->''deps'') d) SELECT EXISTS (SELECT 1 FROM ancestors a JOIN deps e ON e.id=a.id AND e.dep=a.ancestor UNION ALL SELECT 1 FROM ancestors a JOIN deps e ON e.dep=a.id AND e.id=a.ancestor)', v_tasks) INTO v_bad USING p_tasks;
    IF v_bad THEN v_error := '父子任务之间不能建立依赖'; END IF;
  END IF;
  IF v_error IS NULL THEN
    EXECUTE pg_catalog.format('INSERT INTO pg_temp.%1$I(n) SELECT n FROM pg_temp.%2$I UNION ALL SELECT n+1 FROM pg_temp.%2$I', v_nodes, v_tasks);
    -- Leaf S->E; parent S->child S; child E->parent E; dependency E->task S.
    EXECUTE pg_catalog.format('INSERT INTO pg_temp.%1$I SELECT t.n,t.n+1 FROM pg_temp.%2$I t WHERE NOT EXISTS(SELECT 1 FROM pg_temp.%2$I c WHERE c.pid=t.id) UNION SELECT p.n,c.n FROM pg_temp.%2$I c JOIN pg_temp.%2$I p ON p.id=c.pid UNION SELECT c.n+1,p.n+1 FROM pg_temp.%2$I c JOIN pg_temp.%2$I p ON p.id=c.pid', v_edges, v_tasks);
    EXECUTE pg_catalog.format('INSERT INTO pg_temp.%1$I SELECT dep.n+1,t.n FROM pg_catalog.jsonb_array_elements($1) j JOIN pg_temp.%2$I t ON t.id=j.value->>''id'' CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(j.value->''deps'') d JOIN pg_temp.%2$I dep ON dep.id=d.value ON CONFLICT DO NOTHING', v_edges, v_tasks) USING p_tasks;
    EXECUTE pg_catalog.format('UPDATE pg_temp.%1$I t SET degree=(SELECT count(*) FROM pg_temp.%2$I e WHERE e.b=t.n)', v_nodes, v_edges);
    LOOP
      EXECUTE pg_catalog.format('WITH ready AS (DELETE FROM pg_temp.%I WHERE degree=0 RETURNING n) SELECT pg_catalog.array_agg(n) FROM ready', v_nodes) INTO v_ready;
      EXECUTE pg_catalog.format('SELECT count(*)::integer FROM pg_temp.%I', v_nodes) INTO v_count;
      EXIT WHEN v_count = 0;
      IF v_ready IS NULL THEN v_error := '任务或汇总任务依赖存在循环'; EXIT; END IF;
      EXECUTE pg_catalog.format('WITH removed AS (DELETE FROM pg_temp.%1$I WHERE a=ANY($1) RETURNING b),counts AS (SELECT b,count(*)::integer AS n FROM removed GROUP BY b) UPDATE pg_temp.%2$I t SET degree=t.degree-c.n FROM counts c WHERE t.n=c.b', v_edges, v_nodes) USING v_ready;
    END LOOP;
  END IF;
  EXECUTE pg_catalog.format('DROP TABLE pg_temp.%I,pg_temp.%I,pg_temp.%I', v_tasks, v_edges, v_nodes);
  RETURN v_error;
END
$function$;

-- Match JavaScript String.length and String.trim used by project-validation.js.
-- PostgreSQL char_length counts Unicode code points; JavaScript counts UTF-16 units.
CREATE OR REPLACE FUNCTION schedule_private.utf16_length(p_value text)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
  SELECT pg_catalog.char_length(p_value) + pg_catalog.char_length(
    pg_catalog.regexp_replace(p_value COLLATE pg_catalog."C", U&'[^\+010000-\+10FFFF]', '', 'g'))
$function$;

CREATE OR REPLACE FUNCTION schedule_private.js_trim(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
  SELECT pg_catalog.btrim(p_value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$function$;

CREATE OR REPLACE FUNCTION schedule_private.validate_project(p_project jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
DECLARE
  v_task jsonb; v_field jsonb; v_option jsonb; v_pair record; v_meta jsonb;
  v_fields jsonb := '{}'::jsonb; v_ids text[] := ARRAY[]::text[]; v_names text[] := ARRAY[]::text[];
  v_options text[]; v_type text; v_value jsonb; v_count bigint; v_depth integer; v_unsafe boolean;
  v_total_deps integer := 0; v_normalized_groups integer;
BEGIN
  IF p_project IS NULL OR pg_catalog.jsonb_typeof(p_project) <> 'object' THEN RETURN '排期必须为 JSON 对象'; END IF;
  IF p_project->>'format' = 'schedule-gantt-storage' THEN RETURN '共享排期必须为项目对象，不能包含本地存储包装'; END IF;
  IF pg_catalog.octet_length(p_project::text) > 10485760 THEN RETURN '排期超过 10 MiB'; END IF;
  WITH RECURSIVE nodes(value, depth, key_name) AS (
    SELECT p_project, 0, NULL::text
    UNION ALL
    SELECT child.value, n.depth + 1, child.key FROM nodes n CROSS JOIN LATERAL (
      SELECT value, key FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(n.value) = 'object' THEN n.value ELSE '{}'::jsonb END)
      UNION ALL
      SELECT value, NULL::text FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(n.value) = 'array' THEN n.value ELSE '[]'::jsonb END)
    ) child WHERE n.depth <= 32
  ) SELECT count(*), max(depth), COALESCE(bool_or(key_name IN ('__proto__','prototype','constructor') OR schedule_private.utf16_length(key_name)>256
      OR CASE WHEN pg_catalog.jsonb_typeof(value)='number' THEN pg_catalog.abs((value #>> '{}')::numeric)>1.7976931348623157e308::numeric ELSE false END),false)
    INTO v_count,v_depth,v_unsafe FROM nodes;
  IF v_count > 300000 OR v_depth > 32 OR v_unsafe THEN RETURN '排期包含不安全属性、过大数字或结构过于复杂'; END IF;
  IF pg_catalog.jsonb_typeof(p_project->'tasks') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_project->'groups') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_project->'flags') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_project->'meta') IS DISTINCT FROM 'object' THEN RETURN '排期缺少 tasks、groups、flags 或 meta'; END IF;
  IF pg_catalog.jsonb_array_length(p_project->'tasks') > 10000
    OR pg_catalog.jsonb_array_length(p_project->'groups') > 1000
    OR pg_catalog.jsonb_array_length(p_project->'flags') > 10000 THEN RETURN '排期条目过多'; END IF;
  -- Reserve nodes for browser defaults omitted from shared uploads.
  IF v_count + pg_catalog.jsonb_array_length(p_project->'tasks') * 8
      + pg_catalog.jsonb_array_length(p_project->'groups') * 4 + 2048 > 300000 THEN
    RETURN '排期结构过于复杂，缺少规范化所需的空间';
  END IF;
  v_meta := p_project->'meta';
  IF v_meta ?| ARRAY['cols','lw','leftWidth','paneAuto','layoutVersion','nameAutoWidth','columnOrder','hiddenColumns','defView'] THEN RETURN '个人布局不能保存到共享排期'; END IF;
  IF v_meta ? 'title' AND (pg_catalog.jsonb_typeof(v_meta->'title')<>'string' OR schedule_private.utf16_length(v_meta->>'title')>2048) THEN RETURN '排期标题无效或过长'; END IF;
  IF v_meta ? 'hiddenRoles' THEN
    IF pg_catalog.jsonb_typeof(v_meta->'hiddenRoles')<>'array' THEN RETURN '隐藏职能必须为数组'; END IF;
    IF pg_catalog.jsonb_array_length(v_meta->'hiddenRoles')>1000 OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_meta->'hiddenRoles') WHERE pg_catalog.jsonb_typeof(value)<>'string' OR schedule_private.utf16_length(value #>> '{}')>256 OR schedule_private.js_trim(value #>> '{}')='') THEN RETURN '隐藏职能无效'; END IF;
  END IF;
  IF v_meta ? 'roleColors' THEN
    IF pg_catalog.jsonb_typeof(v_meta->'roleColors')<>'object' THEN RETURN '职能颜色必须为对象'; END IF;
    IF (SELECT count(*) FROM pg_catalog.jsonb_each(v_meta->'roleColors'))>1000 OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(v_meta->'roleColors') WHERE schedule_private.js_trim(key)='' OR pg_catalog.jsonb_typeof(value)<>'string' OR (value #>> '{}') !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$') THEN RETURN '职能颜色无效'; END IF;
  END IF;
  FOR v_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_project->'groups') LOOP
    IF pg_catalog.jsonb_typeof(v_value)<>'object' OR pg_catalog.jsonb_typeof(v_value->'name') IS DISTINCT FROM 'string'
      OR schedule_private.utf16_length(v_value->>'name') NOT BETWEEN 1 AND 256 OR schedule_private.js_trim(v_value->>'name')='' OR (v_value->>'name')=ANY(v_names)
      OR pg_catalog.jsonb_typeof(v_value->'color') IS DISTINCT FROM 'string' OR (v_value->>'color')!~'^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' THEN RETURN '职能名称或颜色无效、名称重复'; END IF;
    v_names := pg_catalog.array_append(v_names,v_value->>'name');
  END LOOP;
  FOR v_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_project->'flags') LOOP
    IF pg_catalog.jsonb_typeof(v_value)<>'object' OR pg_catalog.jsonb_typeof(v_value->'id') IS DISTINCT FROM 'string'
      OR schedule_private.utf16_length(v_value->>'id') NOT BETWEEN 1 AND 256 OR schedule_private.js_trim(v_value->>'id')='' OR (v_value->>'id')=ANY(v_ids)
      OR pg_catalog.jsonb_typeof(v_value->'name') IS DISTINCT FROM 'string' OR schedule_private.utf16_length(v_value->>'name')>2048
      OR NOT schedule_private.valid_date(v_value->>'d') OR pg_catalog.jsonb_typeof(v_value->'color') IS DISTINCT FROM 'string'
      OR (v_value->>'color')!~'^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' THEN RETURN '里程碑 ID、名称、日期或颜色无效'; END IF;
    v_ids := pg_catalog.array_append(v_ids,v_value->>'id');
  END LOOP;
  v_ids := ARRAY[]::text[]; v_names := ARRAY[]::text[];
  IF v_meta ? 'customFields' THEN
    IF pg_catalog.jsonb_typeof(v_meta->'customFields') <> 'array' THEN RETURN '自定义字段必须为数组'; END IF;
    IF pg_catalog.jsonb_array_length(v_meta->'customFields') > 50 THEN RETURN '自定义字段最多 50 个'; END IF;
    FOR v_field IN SELECT value FROM pg_catalog.jsonb_array_elements(v_meta->'customFields') LOOP
      IF pg_catalog.jsonb_typeof(v_field) <> 'object'
        OR pg_catalog.jsonb_typeof(v_field->'id') IS DISTINCT FROM 'string'
        OR (v_field->>'id') !~ '^cf_[A-Za-z0-9_-]{1,64}$'
        OR pg_catalog.jsonb_typeof(v_field->'name') IS DISTINCT FROM 'string'
        OR schedule_private.utf16_length(v_field->>'name') NOT BETWEEN 1 AND 128 OR schedule_private.js_trim(v_field->>'name')=''
        OR COALESCE(v_field->>'type','') NOT IN ('text','number','date','select','checkbox')
        OR v_fields ? (v_field->>'id') OR schedule_private.js_trim(v_field->>'name') = ANY(v_names)
        OR schedule_private.js_trim(v_field->>'name') IN ('名称','负责人','开始','结束','进度','职能','阶段') THEN RETURN '自定义字段定义无效或重复'; END IF;
      v_names := pg_catalog.array_append(v_names,schedule_private.js_trim(v_field->>'name'));
      IF v_field->>'type' = 'select' THEN
        IF pg_catalog.jsonb_typeof(v_field->'options') IS DISTINCT FROM 'array' THEN RETURN '单选字段缺少选项'; END IF;
        IF pg_catalog.jsonb_array_length(v_field->'options') > 100 THEN RETURN '单选字段最多 100 个选项'; END IF;
        v_options := ARRAY[]::text[];
        FOR v_option IN SELECT value FROM pg_catalog.jsonb_array_elements(v_field->'options') LOOP
          IF pg_catalog.jsonb_typeof(v_option) <> 'object'
            OR pg_catalog.jsonb_typeof(v_option->'id') IS DISTINCT FROM 'string'
            OR (v_option->>'id') !~ '^fo_[A-Za-z0-9_-]{1,64}$'
            OR pg_catalog.jsonb_typeof(v_option->'label') IS DISTINCT FROM 'string'
            OR schedule_private.utf16_length(v_option->>'label') NOT BETWEEN 1 AND 128 OR schedule_private.js_trim(v_option->>'label')=''
            OR (v_option->>'id') = ANY(v_options) THEN RETURN '单选选项无效或重复'; END IF;
          v_options := pg_catalog.array_append(v_options,v_option->>'id');
        END LOOP;
      ELSIF v_field ? 'options' THEN RETURN '只有单选字段可以设置选项';
      END IF;
      v_fields := v_fields || pg_catalog.jsonb_build_object(v_field->>'id',v_field);
    END LOOP;
  END IF;
  FOR v_task IN SELECT value FROM pg_catalog.jsonb_array_elements(p_project->'tasks') LOOP
    IF pg_catalog.jsonb_typeof(v_task) <> 'object' THEN RETURN '任务必须为对象'; END IF;
    IF pg_catalog.jsonb_typeof(v_task->'id') IS DISTINCT FROM 'string'
      OR schedule_private.utf16_length(v_task->>'id') NOT BETWEEN 1 AND 256 OR schedule_private.js_trim(v_task->>'id')='' OR (v_task->>'id') = ANY(v_ids) THEN RETURN '任务 ID 无效或重复'; END IF;
    v_ids := pg_catalog.array_append(v_ids,v_task->>'id');
    IF pg_catalog.jsonb_typeof(v_task->'name') IS DISTINCT FROM 'string' OR schedule_private.utf16_length(v_task->>'name') > 2048 THEN RETURN '任务名称无效'; END IF;
    FOR v_pair IN SELECT * FROM (VALUES ('who',512),('phase',512),('grp',256)) AS fields(key,max_length) LOOP
      IF v_task ? v_pair.key AND (pg_catalog.jsonb_typeof(v_task->v_pair.key) <> 'string' OR schedule_private.utf16_length(v_task->>v_pair.key)>v_pair.max_length) THEN RETURN '任务文本字段无效'; END IF;
    END LOOP;
    IF COALESCE(v_task->>'type','') NOT IN ('task','milestone','pipeline') THEN RETURN '任务类型无效'; END IF;
    IF NOT (v_task ? 'pid') OR (pg_catalog.jsonb_typeof(v_task->'pid') NOT IN ('null','string')) THEN RETURN '任务父级无效'; END IF;
    IF pg_catalog.jsonb_typeof(v_task->'pid') = 'string' AND (schedule_private.utf16_length(v_task->>'pid') NOT BETWEEN 1 AND 256 OR schedule_private.js_trim(v_task->>'pid')='') THEN RETURN '任务父级无效'; END IF;
    IF NOT schedule_private.valid_date(v_task->>'s') OR NOT schedule_private.valid_date(v_task->>'e') OR v_task->>'s' > v_task->>'e' THEN RETURN '任务日期无效'; END IF;
    IF v_task->>'type' = 'milestone' AND v_task->>'s' <> v_task->>'e' THEN RETURN '节点的开始结束日期必须一致'; END IF;
    IF pg_catalog.jsonb_typeof(v_task->'pct') IS DISTINCT FROM 'number' THEN RETURN '任务进度无效'; END IF;
    IF (v_task->>'pct')::numeric NOT BETWEEN 0 AND 100 THEN RETURN '任务进度必须在 0 到 100 之间'; END IF;
    IF pg_catalog.jsonb_typeof(v_task->'flow') IS DISTINCT FROM 'boolean' THEN RETURN '任务 flow 无效'; END IF;
    IF pg_catalog.jsonb_typeof(v_task->'lane') IS DISTINCT FROM 'number' THEN RETURN '任务泳道无效'; END IF;
    IF (v_task->>'lane')::numeric NOT BETWEEN 0 AND 10000 OR (v_task->>'lane')::numeric <> pg_catalog.trunc((v_task->>'lane')::numeric) THEN RETURN '任务泳道无效'; END IF;
    IF v_task ?| ARRAY['fold','collapsed'] THEN RETURN '个人折叠状态不能保存到共享排期'; END IF;
    IF pg_catalog.jsonb_typeof(v_task->'deps') IS DISTINCT FROM 'array' THEN RETURN '任务依赖必须为数组'; END IF;
    v_count := pg_catalog.jsonb_array_length(v_task->'deps'); v_total_deps := v_total_deps + v_count;
    IF v_count > 10000 OR v_total_deps > 100000 THEN RETURN '任务依赖过多'; END IF;
    IF v_task->>'type' = 'pipeline' AND (v_task->>'pid' IS NOT NULL OR v_count > 0) THEN RETURN '管线只能位于顶层且不能有依赖'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_task->'deps') WHERE pg_catalog.jsonb_typeof(value)<>'string' OR schedule_private.utf16_length(value #>> '{}') NOT BETWEEN 1 AND 256 OR schedule_private.js_trim(value #>> '{}')='')
      OR (SELECT count(DISTINCT value) FROM pg_catalog.jsonb_array_elements(v_task->'deps')) <> v_count THEN RETURN '任务依赖 ID 无效或重复'; END IF;
    IF v_task ? 'customValues' THEN
      IF pg_catalog.jsonb_typeof(v_task->'customValues') <> 'object' THEN RETURN '自定义值必须为对象'; END IF;
      FOR v_pair IN SELECT * FROM pg_catalog.jsonb_each(v_task->'customValues') LOOP
        IF NOT (v_fields ? v_pair.key) THEN RETURN '自定义值引用不存在的字段'; END IF;
        v_field := v_fields->v_pair.key; v_type := v_field->>'type'; v_value := v_pair.value;
        IF pg_catalog.jsonb_typeof(v_value) = 'null' THEN CONTINUE; END IF;
        IF v_type = 'text' AND (pg_catalog.jsonb_typeof(v_value)<>'string' OR schedule_private.utf16_length(v_value #>> '{}')>4096) THEN RETURN '自定义文本无效'; END IF;
        IF v_type = 'number' AND pg_catalog.jsonb_typeof(v_value)<>'number' THEN RETURN '自定义数字无效'; END IF;
        IF v_type = 'date' AND (pg_catalog.jsonb_typeof(v_value)<>'string' OR NOT schedule_private.valid_date(v_value #>> '{}')) THEN RETURN '自定义日期无效'; END IF;
        IF v_type = 'checkbox' AND pg_catalog.jsonb_typeof(v_value)<>'boolean' THEN RETURN '自定义勾选值无效'; END IF;
        IF v_type = 'select' AND (pg_catalog.jsonb_typeof(v_value)<>'string' OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_field->'options') WHERE value->>'id' = v_value #>> '{}')) THEN RETURN '自定义单选值无效'; END IF;
      END LOOP;
    END IF;
  END LOOP;
  -- The browser restores active built-in roles and removes obsolete aliases.
  -- Count that normalized set too, so a payload at the limit can still reopen.
  WITH used_roles AS (
    SELECT DISTINCT CASE WHEN value->>'type'='pipeline' THEN '' ELSE
      CASE COALESCE(value->>'grp','')
        WHEN '玩法策划GD' THEN '策划' WHEN '关卡策划LD' THEN '策划'
        WHEN '技术策划TD' THEN '技术策划' WHEN '技术美术TA' THEN '技术美术'
        ELSE COALESCE(value->>'grp','') END END AS name
    FROM pg_catalog.jsonb_array_elements(p_project->'tasks')
  ), defaults(name) AS (VALUES ('策划'),('美术'),('程序'),('技术策划'),('技术美术'),('动画')),
  normalized AS (
    SELECT d.name FROM defaults d WHERE EXISTS(SELECT 1 FROM used_roles u WHERE u.name=d.name)
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(COALESCE(v_meta->'hiddenRoles','[]'::jsonb)) h WHERE h.value=d.name)
    UNION ALL
    SELECT g.value->>'name' FROM pg_catalog.jsonb_array_elements(p_project->'groups') g
      WHERE g.value->>'name' NOT IN ('策划','美术','程序','技术策划','技术美术','动画','玩法策划GD','关卡策划LD','技术策划TD','技术美术TA')
      AND (g.value->>'name' NOT IN ('设计','开发','测试','产品','音频','其他')
        OR EXISTS(SELECT 1 FROM used_roles u WHERE u.name=g.value->>'name'))
  ) SELECT count(*)::integer INTO v_normalized_groups FROM normalized;
  IF v_normalized_groups > 1000 THEN RETURN '归一化后的职能数量超过 1000'; END IF;
  RETURN schedule_private.validate_graph(p_project->'tasks');
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_get_project(p_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_row schedule_private.projects;
BEGIN
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' THEN RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 无效'); END IF;
  SELECT * INTO v_row FROM schedule_private.projects WHERE id = p_id;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','排期不存在'); END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.public_record(v_row));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_create_project(p_id text, p_edit_code text, p_display_name text, p_project jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_retry integer; v_error text; v_row schedule_private.projects; v_session jsonb; v_name text := schedule_private.js_trim(p_display_name);
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST') <> 'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_edit_code IS NULL OR p_edit_code !~ '^[0-9]{4}$'
    OR v_name IS NULL OR schedule_private.utf16_length(v_name) NOT BETWEEN 1 AND 64 OR schedule_private.utf16_length(p_display_name)>64 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','请填写有效的排期 ID、昵称和四位编辑码');
  END IF;
  v_retry := schedule_private.reserve_budget('create:global',20,3600);
  IF v_retry > 0 THEN RETURN schedule_private.failure('RATE_LIMITED','创建排期过于频繁，请稍后再试',v_retry); END IF;
  v_error := schedule_private.validate_project(p_project);
  IF v_error IS NOT NULL THEN RETURN schedule_private.failure('VALIDATION_ERROR',v_error); END IF;
  INSERT INTO schedule_private.projects(id,project,updated_by,edit_code_hash)
    VALUES(p_id,p_project,v_name,schedule_private.hash_code(p_edit_code))
    ON CONFLICT(id) DO NOTHING RETURNING * INTO v_row;
  IF NOT FOUND THEN RETURN schedule_private.failure('PROJECT_EXISTS','排期 ID 已存在，请重试创建'); END IF;
  v_session := schedule_private.issue_session(p_id,v_name);
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.public_record(v_row) || pg_catalog.jsonb_build_object('session',v_session));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_unlock_project(p_id text, p_edit_code text, p_display_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_retry integer; v_hash text; v_name text := schedule_private.js_trim(p_display_name);
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST') <> 'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_edit_code IS NULL OR p_edit_code !~ '^[0-9]{4}$'
    OR v_name IS NULL OR schedule_private.utf16_length(v_name) NOT BETWEEN 1 AND 64 OR schedule_private.utf16_length(p_display_name)>64 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','请填写有效的昵称和四位编辑码');
  END IF;
  v_retry := schedule_private.reserve_budget('unlock:global',120,60);
  IF v_retry > 0 THEN RETURN schedule_private.failure('RATE_LIMITED','请求过于频繁，请稍后再试',v_retry); END IF;
  SELECT edit_code_hash INTO v_hash FROM schedule_private.projects WHERE id = p_id;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','排期不存在'); END IF;
  v_retry := schedule_private.reserve_budget('unlock:' || p_id,10,900);
  IF v_retry > 0 THEN RETURN schedule_private.failure('RATE_LIMITED','此排期的编辑码尝试过于频繁，请稍后再试',v_retry); END IF;
  IF NOT schedule_private.code_matches(p_edit_code,v_hash) THEN
    -- Deliberately return, do NOT RAISE: the reserved attempts must commit.
    RETURN schedule_private.failure('INVALID_EDIT_CODE','编辑码不正确');
  END IF;
  -- Refund only this successful reservation, preserving previous failures.
  -- A board already at 10 failures remains locked until its window expires.
  UPDATE schedule_private.request_budgets SET attempts=GREATEST(0,attempts-1) WHERE budget_key='unlock:' || p_id;
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.issue_session(p_id,v_name));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_save_project(p_id text, p_token text, p_expected_revision integer, p_project jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_session schedule_private.sessions; v_row schedule_private.projects; v_error text; v_hash text;
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST') <> 'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 或版本号无效');
  END IF;
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN schedule_private.failure('UNAUTHORIZED','请重新输入编辑码'); END IF;
  v_hash := schedule_private.token_digest(p_token);
  SELECT * INTO v_session FROM schedule_private.sessions WHERE token_hash = v_hash AND project_id = p_id FOR UPDATE;
  IF NOT FOUND OR v_session.expires_at <= pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','编辑权限已过期，请重新输入编辑码'); END IF;
  v_error := schedule_private.validate_project(p_project);
  IF v_error IS NOT NULL THEN RETURN schedule_private.failure('VALIDATION_ERROR',v_error); END IF;
  IF p_expected_revision = 2147483647 THEN RETURN schedule_private.failure('VALIDATION_ERROR','排期版本号已达到上限'); END IF;
  UPDATE schedule_private.projects p SET project = p_project, revision = p.revision + 1,
    updated_at = pg_catalog.clock_timestamp(), updated_by = v_session.display_name
    WHERE p.id = p_id AND p.revision = p_expected_revision
      AND EXISTS(SELECT 1 FROM schedule_private.sessions s WHERE s.token_hash = v_hash
        AND s.project_id = p_id AND s.expires_at > pg_catalog.clock_timestamp())
    RETURNING p.* INTO v_row;
  IF FOUND THEN RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.public_record(v_row)); END IF;
  IF v_session.expires_at <= pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','编辑权限已过期，请重新输入编辑码'); END IF;
  SELECT * INTO v_row FROM schedule_private.projects WHERE id = p_id;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','排期不存在'); END IF;
  RETURN schedule_private.failure('REVISION_CONFLICT','其他人已修改排期，请先查看最新版本')
    || pg_catalog.jsonb_build_object('latest',schedule_private.public_record(v_row));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_revoke_session(p_id text, p_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST') <> 'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 或编辑令牌无效');
  END IF;
  DELETE FROM schedule_private.sessions WHERE project_id = p_id AND token_hash = schedule_private.token_digest(p_token);
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',pg_catalog.jsonb_build_object('revoked',true));
END
$function$;

ALTER FUNCTION public.schedule_get_project(text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.schedule_create_project(text,text,text,jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION public.schedule_unlock_project(text,text,text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.schedule_save_project(text,text,integer,jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION public.schedule_revoke_session(text,text) OWNER TO CURRENT_USER;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA schedule_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_get_project(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_create_project(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_unlock_project(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_save_project(text,text,integer,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_revoke_session(text,text) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_get_project(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_create_project(text,text,text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_unlock_project(text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_save_project(text,text,integer,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_revoke_session(text,text) TO anon, authenticated;
COMMENT ON SCHEMA schedule_private IS 'Schedule private hashes, token digests and atomic request budgets. Never expose via PostgREST.';
COMMENT ON FUNCTION public.schedule_unlock_project(text,text,text) IS 'POST JSON only. Failed codes return normally to commit budgets; gateway must disallow rollback transactions.';
NOTIFY pgrst, 'reload schema';

COMMIT;
