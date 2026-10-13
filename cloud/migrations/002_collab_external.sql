-- V2 collaboration and external credentials. Apply AFTER 001_schedule_rpc.sql
-- through the same administrator migration channel, in this app's database.
-- Re-running preserves project data, existing API keys, and valid sessions.
-- The gateway must commit RPC transactions; an outer rollback cannot be fixed
-- inside PostgreSQL. Business failures RETURN normally so budgets are committed.
BEGIN;

DO $migration$
BEGIN
  IF current_user IN ('anon','authenticated') OR pg_catalog.to_regclass('schedule_private.projects') IS NULL THEN
    RAISE EXCEPTION 'Apply 001 first, then run 002 using the same administrator';
  END IF;
END
$migration$;

ALTER TABLE schedule_private.projects ADD COLUMN IF NOT EXISTS api_key_hash text;
-- Legacy boards receive an unexposed random key digest. Their human editor can
-- issue a usable key with schedule_reset_api_key; no plaintext migration export.
UPDATE schedule_private.projects SET api_key_hash=schedule_private.token_digest(schedule_private.new_token()) WHERE api_key_hash IS NULL;
ALTER TABLE schedule_private.projects ALTER COLUMN api_key_hash SET NOT NULL;
ALTER TABLE schedule_private.projects ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'human';
ALTER TABLE schedule_private.sessions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'human';
ALTER TABLE schedule_private.sessions ADD COLUMN IF NOT EXISTS last_seen timestamptz;
UPDATE schedule_private.sessions SET last_seen=created_at WHERE last_seen IS NULL;
ALTER TABLE schedule_private.sessions ALTER COLUMN last_seen SET DEFAULT pg_catalog.clock_timestamp();
ALTER TABLE schedule_private.sessions ALTER COLUMN last_seen SET NOT NULL;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='schedule_private.projects'::regclass AND conname='schedule_projects_api_hash') THEN
    ALTER TABLE schedule_private.projects ADD CONSTRAINT schedule_projects_api_hash CHECK(api_key_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='schedule_private.projects'::regclass AND conname='schedule_projects_source') THEN
    ALTER TABLE schedule_private.projects ADD CONSTRAINT schedule_projects_source CHECK(source IN ('human','external'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='schedule_private.sessions'::regclass AND conname='schedule_sessions_source') THEN
    ALTER TABLE schedule_private.sessions ADD CONSTRAINT schedule_sessions_source CHECK(source IN ('human','external'));
  END IF;
END
$constraints$;

CREATE OR REPLACE FUNCTION schedule_private.public_record(p_row schedule_private.projects)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.jsonb_build_object('id',p_row.id,'revision',p_row.revision,
    'project',p_row.project,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,
    'updatedBy',p_row.updated_by,'source',p_row.source)
$function$;

-- Compare all 32 digest bytes without a prefix-dependent early return. This is
-- not a claim of whole-request constant-time behavior in a SQL runtime.
CREATE OR REPLACE FUNCTION schedule_private.digest_matches(p_left text,p_right text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_left bytea; v_right bytea; v_difference integer:=0; v_i integer;
BEGIN
  IF p_left IS NULL OR p_right IS NULL OR p_left !~ '^[a-f0-9]{64}$' OR p_right !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  v_left:=pg_catalog.decode(p_left,'hex'); v_right:=pg_catalog.decode(p_right,'hex');
  FOR v_i IN 0..31 LOOP
    v_difference:=v_difference | (pg_catalog.get_byte(v_left,v_i) # pg_catalog.get_byte(v_right,v_i));
  END LOOP;
  RETURN v_difference=0;
END
$function$;

-- Uniform lock order: request-global budget, project row, board budget, session.
-- Every RPC which locks a session also locks its project first. Key reset cannot
-- race a successful old-key exchange or an already-authorized external write.
CREATE OR REPLACE FUNCTION schedule_private.issue_session(p_id text,p_name text,p_source text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $function$
DECLARE v_token text; v_expiry timestamptz:=pg_catalog.clock_timestamp()+interval '12 hours';
BEGIN
  IF p_source NOT IN ('human','external') OR p_source IS NULL THEN RAISE EXCEPTION 'Invalid internal session source'; END IF;
  PERFORM 1 FROM schedule_private.projects WHERE id=p_id FOR UPDATE;
  -- Only touch this board's rows. Cross-board opportunistic cleanup can invert
  -- session lock order while concurrent transactions each hold a project lock.
  -- Each board has at most 50 rows, so this cleanup is bounded without scanning
  -- or locking another board's sessions.
  DELETE FROM schedule_private.sessions WHERE project_id=p_id AND expires_at<=pg_catalog.clock_timestamp();
  DELETE FROM schedule_private.sessions WHERE token_hash IN
    (SELECT token_hash FROM schedule_private.sessions WHERE project_id=p_id ORDER BY expires_at DESC,token_hash OFFSET 49);
  v_token:=schedule_private.new_token();
  INSERT INTO schedule_private.sessions(token_hash,project_id,display_name,expires_at,source,last_seen)
    VALUES(schedule_private.token_digest(v_token),p_id,p_name,v_expiry,p_source,pg_catalog.clock_timestamp());
  RETURN pg_catalog.jsonb_build_object('token',v_token,'displayName',p_name,'expiresAt',v_expiry,'source',p_source);
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.issue_session(p_id text,p_name text)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $function$
  SELECT schedule_private.issue_session(p_id,p_name,'human')
$function$;

-- NULL means authenticated. Successful attempts refund only their own board
-- reservation; wrong-code history is retained. Never expose this helper as RPC.
CREATE OR REPLACE FUNCTION schedule_private.authorize_human_code(p_id text,p_edit_code text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $function$
DECLARE v_retry integer; v_hash text;
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST')<>'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_edit_code IS NULL OR p_edit_code !~ '^[0-9]{4}$' THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','请填写有效的排期 ID 和四位编辑码');
  END IF;
  v_retry:=schedule_private.reserve_budget('unlock:global',120,60);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','请求过于频繁，请稍后再试',v_retry); END IF;
  SELECT edit_code_hash INTO v_hash FROM schedule_private.projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','排期不存在'); END IF;
  v_retry:=schedule_private.reserve_budget('unlock:'||p_id,10,900);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','此排期的编辑码尝试过于频繁，请稍后再试',v_retry); END IF;
  IF NOT schedule_private.code_matches(p_edit_code,v_hash) THEN RETURN schedule_private.failure('INVALID_EDIT_CODE','编辑码不正确'); END IF;
  UPDATE schedule_private.request_budgets SET attempts=GREATEST(0,attempts-1) WHERE budget_key='unlock:'||p_id;
  RETURN NULL;
END
$function$;

-- External key exchanges and action requests share this separate 60/minute
-- global + board channel. Unknown project IDs never allocate per-board keys.
CREATE OR REPLACE FUNCTION schedule_private.reserve_external_request(p_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $function$
DECLARE v_retry integer;
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST')<>'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' THEN RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 无效'); END IF;
  v_retry:=schedule_private.reserve_budget('external:global',60,60);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','外部接口请求过于频繁，请稍后再试',v_retry); END IF;
  PERFORM 1 FROM schedule_private.projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','排期不存在'); END IF;
  v_retry:=schedule_private.reserve_budget('external:'||p_id,60,60);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','此排期的外部接口请求过于频繁，请稍后再试',v_retry); END IF;
  RETURN NULL;
END
$function$;

-- Action migration 003 calls this guard BEFORE reading/validating/applying data.
-- NULL = valid external session, with project AND session locked until commit.
-- Otherwise return the error JSON unchanged; never raise for business failures.
CREATE OR REPLACE FUNCTION schedule_private.authorize_external(p_id text,p_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $function$
DECLARE v_error jsonb; v_session schedule_private.sessions; v_hash text;
BEGIN
  v_error:=schedule_private.reserve_external_request(p_id);
  IF v_error IS NOT NULL THEN RETURN v_error; END IF;
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN schedule_private.failure('UNAUTHORIZED','请使用 API 密钥重新授权'); END IF;
  v_hash:=schedule_private.token_digest(p_token);
  SELECT * INTO v_session FROM schedule_private.sessions WHERE token_hash=v_hash AND project_id=p_id FOR UPDATE;
  IF NOT FOUND OR v_session.expires_at<=pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','外部会话已失效，请重新授权'); END IF;
  IF v_session.source<>'external' THEN RETURN schedule_private.failure('FORBIDDEN','此操作需要外部 API 会话'); END IF;
  UPDATE schedule_private.sessions SET last_seen=pg_catalog.clock_timestamp() WHERE token_hash=v_hash;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_create_project(p_id text,p_edit_code text,p_display_name text,p_project jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_retry integer; v_error text; v_row schedule_private.projects; v_session jsonb;
  v_name text:=schedule_private.js_trim(p_display_name); v_key text;
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST')<>'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_edit_code IS NULL OR p_edit_code !~ '^[0-9]{4}$'
    OR v_name IS NULL OR schedule_private.utf16_length(v_name) NOT BETWEEN 1 AND 64 OR schedule_private.utf16_length(p_display_name)>64 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','请填写有效的排期 ID、昵称和四位编辑码');
  END IF;
  v_retry:=schedule_private.reserve_budget('create:global',20,3600);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','创建排期过于频繁，请稍后再试',v_retry); END IF;
  v_error:=schedule_private.validate_project(p_project);
  IF v_error IS NOT NULL THEN RETURN schedule_private.failure('VALIDATION_ERROR',v_error); END IF;
  v_key:=schedule_private.new_token();
  INSERT INTO schedule_private.projects(id,project,updated_by,edit_code_hash,api_key_hash,source)
    VALUES(p_id,p_project,v_name,schedule_private.hash_code(p_edit_code),schedule_private.token_digest(v_key),'human')
    ON CONFLICT(id) DO NOTHING RETURNING * INTO v_row;
  IF NOT FOUND THEN RETURN schedule_private.failure('PROJECT_EXISTS','排期 ID 已存在，请重试创建'); END IF;
  v_session:=schedule_private.issue_session(p_id,v_name,'human');
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.public_record(v_row)||pg_catalog.jsonb_build_object('session',v_session,'apiKey',v_key));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_unlock_project(p_id text,p_edit_code text,p_display_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_error jsonb; v_name text:=schedule_private.js_trim(p_display_name);
BEGIN
  IF v_name IS NULL OR schedule_private.utf16_length(v_name) NOT BETWEEN 1 AND 64 OR schedule_private.utf16_length(p_display_name)>64 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','请填写有效的昵称和四位编辑码');
  END IF;
  v_error:=schedule_private.authorize_human_code(p_id,p_edit_code);
  IF v_error IS NOT NULL THEN RETURN v_error; END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.issue_session(p_id,v_name,'human'));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_unlock_external(p_id text,p_api_key text,p_display_name text DEFAULT 'AI助手')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_error jsonb; v_hash text; v_name text:=schedule_private.js_trim(p_display_name);
BEGIN
  IF v_name IS NULL OR schedule_private.utf16_length(v_name) NOT BETWEEN 1 AND 64 OR schedule_private.utf16_length(p_display_name)>64 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','请填写 1 至 64 字符的外部操作昵称');
  END IF;
  v_error:=schedule_private.reserve_external_request(p_id);
  IF v_error IS NOT NULL THEN RETURN v_error; END IF;
  IF p_api_key IS NULL OR p_api_key !~ '^[a-f0-9]{64}$' THEN RETURN schedule_private.failure('INVALID_API_KEY','API 密钥不正确'); END IF;
  SELECT api_key_hash INTO v_hash FROM schedule_private.projects WHERE id=p_id;
  IF NOT schedule_private.digest_matches(schedule_private.token_digest(p_api_key),v_hash) THEN
    RETURN schedule_private.failure('INVALID_API_KEY','API 密钥不正确');
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.issue_session(p_id,v_name,'external'));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_reset_api_key(p_id text,p_edit_code text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_error jsonb; v_key text;
BEGIN
  v_error:=schedule_private.authorize_human_code(p_id,p_edit_code);
  IF v_error IS NOT NULL THEN RETURN v_error; END IF;
  v_key:=schedule_private.new_token();
  UPDATE schedule_private.projects SET api_key_hash=schedule_private.token_digest(v_key) WHERE id=p_id;
  DELETE FROM schedule_private.sessions WHERE project_id=p_id AND source='external';
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',pg_catalog.jsonb_build_object('apiKey',v_key));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_save_project(p_id text,p_token text,p_expected_revision integer,p_project jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_session schedule_private.sessions; v_row schedule_private.projects; v_error text; v_hash text;
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST')<>'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_expected_revision IS NULL OR p_expected_revision<1 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 或版本号无效');
  END IF;
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN schedule_private.failure('UNAUTHORIZED','请重新输入编辑码'); END IF;
  PERFORM 1 FROM schedule_private.projects WHERE id=p_id FOR UPDATE;
  v_hash:=schedule_private.token_digest(p_token);
  SELECT * INTO v_session FROM schedule_private.sessions WHERE token_hash=v_hash AND project_id=p_id FOR UPDATE;
  IF NOT FOUND OR v_session.expires_at<=pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','编辑权限已过期，请重新输入编辑码'); END IF;
  IF v_session.source<>'human' THEN RETURN schedule_private.failure('FORBIDDEN','外部会话请使用动作接口保存'); END IF;
  v_error:=schedule_private.validate_project(p_project);
  IF v_error IS NOT NULL THEN RETURN schedule_private.failure('VALIDATION_ERROR',v_error); END IF;
  IF p_expected_revision=2147483647 THEN RETURN schedule_private.failure('VALIDATION_ERROR','排期版本号已达到上限'); END IF;
  UPDATE schedule_private.projects p SET project=p_project,revision=p.revision+1,updated_at=pg_catalog.clock_timestamp(),updated_by=v_session.display_name,source='human'
    WHERE p.id=p_id AND p.revision=p_expected_revision
      AND EXISTS(SELECT 1 FROM schedule_private.sessions s WHERE s.token_hash=v_hash AND s.project_id=p_id AND s.source='human' AND s.expires_at>pg_catalog.clock_timestamp())
    RETURNING p.* INTO v_row;
  IF FOUND THEN
    UPDATE schedule_private.sessions SET last_seen=pg_catalog.clock_timestamp() WHERE token_hash=v_hash;
    RETURN pg_catalog.jsonb_build_object('ok',true,'data',schedule_private.public_record(v_row));
  END IF;
  IF v_session.expires_at<=pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','编辑权限已过期，请重新输入编辑码'); END IF;
  SELECT * INTO v_row FROM schedule_private.projects WHERE id=p_id;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','排期不存在'); END IF;
  RETURN schedule_private.failure('REVISION_CONFLICT','其他人已修改排期，请先查看最新版本')||pg_catalog.jsonb_build_object('latest',schedule_private.public_record(v_row));
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_revoke_session(p_id text,p_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST')<>'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 或编辑令牌无效');
  END IF;
  PERFORM 1 FROM schedule_private.projects WHERE id=p_id FOR UPDATE;
  DELETE FROM schedule_private.sessions WHERE project_id=p_id AND token_hash=schedule_private.token_digest(p_token);
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',pg_catalog.jsonb_build_object('revoked',true));
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.presence(p_id text,p_token text,p_touch boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $function$
DECLARE v_retry integer; v_session schedule_private.sessions; v_members jsonb; v_now timestamptz; v_hash text;
BEGIN
  IF schedule_private.rollback_requested() OR COALESCE(NULLIF(pg_catalog.current_setting('request.method',true),''),'POST')<>'POST' THEN
    RETURN schedule_private.failure('UNSUPPORTED_REQUEST','请使用默认 JSON POST 请求，禁用事务回滚和结果转换选项');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{32}$' THEN RETURN schedule_private.failure('VALIDATION_ERROR','排期 ID 无效'); END IF;
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN schedule_private.failure('UNAUTHORIZED','请先解锁排期'); END IF;
  -- 50 editors at 20-second heartbeats use 150 requests/minute per board.
  -- 600 leaves room for manual lists, and the global cap bounds total work.
  v_retry:=schedule_private.reserve_budget('presence:global',6000,60);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','在线状态查询过于频繁',v_retry); END IF;
  PERFORM 1 FROM schedule_private.projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN schedule_private.failure('UNAUTHORIZED','编辑权限已失效，请重新解锁排期'); END IF;
  v_retry:=schedule_private.reserve_budget('presence:'||p_id,600,60);
  IF v_retry>0 THEN RETURN schedule_private.failure('RATE_LIMITED','此排期的在线状态查询过于频繁',v_retry); END IF;
  v_hash:=schedule_private.token_digest(p_token);
  SELECT * INTO v_session FROM schedule_private.sessions WHERE token_hash=v_hash AND project_id=p_id FOR UPDATE;
  IF NOT FOUND OR v_session.expires_at<=pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','编辑权限已失效，请重新解锁排期'); END IF;
  v_now:=pg_catalog.clock_timestamp();
  IF p_touch THEN UPDATE schedule_private.sessions SET last_seen=v_now WHERE token_hash=v_hash; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('displayName',display_name,'lastSeenAt',last_seen,
    'online',last_seen>=v_now-interval '60 seconds','source',source) ORDER BY last_seen DESC,created_at DESC),'[]'::jsonb)
    INTO v_members FROM schedule_private.sessions WHERE project_id=p_id AND expires_at>v_now;
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',pg_catalog.jsonb_build_object('members',v_members,'onlineThresholdSeconds',60));
END
$function$;

-- Lists intentionally require a valid project-bound session. There is no
-- anonymous one-argument overload exposing nicknames or editor activity.
CREATE OR REPLACE FUNCTION public.schedule_list_presence(p_id text,p_token text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT schedule_private.presence(p_id,p_token,false)
$function$;
CREATE OR REPLACE FUNCTION public.schedule_heartbeat(p_id text,p_token text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT schedule_private.presence(p_id,p_token,true)
$function$;

REVOKE ALL ON SCHEMA schedule_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA schedule_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA schedule_private FROM PUBLIC,anon,authenticated;
DO $rpc_acl$
DECLARE v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.schedule_create_project(text,text,text,jsonb)',
    'public.schedule_unlock_project(text,text,text)',
    'public.schedule_save_project(text,text,integer,jsonb)',
    'public.schedule_revoke_session(text,text)',
    'public.schedule_unlock_external(text,text,text)',
    'public.schedule_reset_api_key(text,text)',
    'public.schedule_list_presence(text,text)',
    'public.schedule_heartbeat(text,text)']
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO CURRENT_USER',v_signature);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',v_signature);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO anon,authenticated',v_signature);
  END LOOP;
END
$rpc_acl$;
NOTIFY pgrst,'reload schema';
COMMIT;
