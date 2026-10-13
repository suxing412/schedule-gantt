-- AI tool actions. Apply after 001 and 002 using the administrator migration
-- channel. Only the public RPC is exposed. Pure helpers never write tables.
-- Business failures return normally after auth/budget reservations, so the
-- transaction commits the attempted request without a partial project update.
BEGIN;

DO $migration$
BEGIN
  IF current_user IN ('anon','authenticated')
    OR pg_catalog.to_regprocedure('schedule_private.authorize_external(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply 001 and 002 before 003 using the same administrator';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION schedule_private.tool_reject(p_code text,p_message text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=p_message,DETAIL=p_code;
END
$function$;

-- The supported JSON-schema subset is deliberately small and matches the
-- bundled operation-definitions.json; this is validation, never code evaluation.
CREATE OR REPLACE FUNCTION schedule_private.tool_schema_error(p_value jsonb,p_schema jsonb,p_path text DEFAULT 'arguments',p_depth integer DEFAULT 0)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_type text; v_pair record; v_child jsonb; v_error text; v_count integer;
BEGIN
  IF p_depth>40 THEN RETURN p_path||': structure too deep'; END IF;
  IF p_schema ? 'anyOf' THEN
    FOR v_child IN SELECT value FROM pg_catalog.jsonb_array_elements(p_schema->'anyOf') LOOP
      IF schedule_private.tool_schema_error(p_value,v_child,p_path,p_depth+1) IS NULL THEN RETURN NULL; END IF;
    END LOOP;
    RETURN p_path||': does not match an allowed value type';
  END IF;
  IF p_schema ? 'const' AND p_value IS DISTINCT FROM p_schema->'const' THEN RETURN p_path||': invalid constant'; END IF;
  IF p_schema ? 'enum' AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(p_schema->'enum') WHERE value=p_value) THEN RETURN p_path||': invalid option'; END IF;
  v_type:=pg_catalog.jsonb_typeof(p_value);
  IF p_schema ? 'type' AND NOT (v_type=p_schema->>'type' OR (p_schema->>'type'='integer' AND v_type='number')) THEN RETURN p_path||': invalid type'; END IF;
  IF v_type='number' THEN
    IF (p_schema->>'type'='integer' AND (p_value #>> '{}')::numeric<>pg_catalog.trunc((p_value #>> '{}')::numeric))
      OR (p_schema ? 'minimum' AND (p_value #>> '{}')::numeric<(p_schema->>'minimum')::numeric)
      OR (p_schema ? 'maximum' AND (p_value #>> '{}')::numeric>(p_schema->>'maximum')::numeric) THEN RETURN p_path||': number out of range'; END IF;
  ELSIF v_type='string' THEN
    v_count:=schedule_private.utf16_length(p_value #>> '{}');
    IF (p_schema ? 'minLength' AND v_count<(p_schema->>'minLength')::integer)
      OR (p_schema ? 'maxLength' AND v_count>(p_schema->>'maxLength')::integer)
      OR (p_schema ? 'pattern' AND (p_value #>> '{}')!~(p_schema->>'pattern')) THEN RETURN p_path||': invalid string'; END IF;
  ELSIF v_type='object' THEN
    SELECT count(*) INTO v_count FROM pg_catalog.jsonb_each(p_value);
    IF (p_schema ? 'minProperties' AND v_count<(p_schema->>'minProperties')::integer)
      OR (p_schema ? 'maxProperties' AND v_count>(p_schema->>'maxProperties')::integer) THEN RETURN p_path||': invalid property count'; END IF;
    IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(COALESCE(p_schema->'required','[]'::jsonb)) WHERE NOT (p_value ? value)) THEN RETURN p_path||': missing required property'; END IF;
    FOR v_pair IN SELECT * FROM pg_catalog.jsonb_each(p_value) LOOP
      IF p_schema ? 'propertyNames' THEN
        v_error:=schedule_private.tool_schema_error(pg_catalog.to_jsonb(v_pair.key),p_schema->'propertyNames',p_path||'.key',p_depth+1);
        IF v_error IS NOT NULL THEN RETURN v_error; END IF;
      END IF;
      IF COALESCE(p_schema->'properties','{}'::jsonb) ? v_pair.key THEN
        v_child:=p_schema->'properties'->v_pair.key;
      ELSIF p_schema->'additionalProperties'='false'::jsonb THEN RETURN p_path||': unknown property '||v_pair.key;
      ELSIF pg_catalog.jsonb_typeof(p_schema->'additionalProperties')='object' THEN v_child:=p_schema->'additionalProperties';
      ELSE CONTINUE;
      END IF;
      v_error:=schedule_private.tool_schema_error(v_pair.value,v_child,p_path||'.'||v_pair.key,p_depth+1);
      IF v_error IS NOT NULL THEN RETURN v_error; END IF;
    END LOOP;
  ELSIF v_type='array' THEN
    v_count:=pg_catalog.jsonb_array_length(p_value);
    IF (p_schema ? 'minItems' AND v_count<(p_schema->>'minItems')::integer)
      OR (p_schema ? 'maxItems' AND v_count>(p_schema->>'maxItems')::integer)
      OR (p_schema->'uniqueItems'='true'::jsonb AND (SELECT count(DISTINCT value) FROM pg_catalog.jsonb_array_elements(p_value))<>v_count) THEN RETURN p_path||': invalid array length or duplicates'; END IF;
    IF p_schema ? 'items' THEN
      FOR v_pair IN SELECT value,ordinality FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY LOOP
        v_error:=schedule_private.tool_schema_error(v_pair.value,p_schema->'items',p_path||'['||(v_pair.ordinality-1)::text||']',p_depth+1);
        IF v_error IS NOT NULL THEN RETURN v_error; END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_json_error(p_json jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_count bigint; v_depth integer; v_unsafe boolean;
BEGIN
  IF p_json IS NULL OR pg_catalog.octet_length(p_json::text)>10485760 THEN RETURN 'Action exceeds 10 MiB or is missing'; END IF;
  WITH RECURSIVE nodes(value,depth,key_name) AS (
    SELECT p_json,0,NULL::text UNION ALL
    SELECT child.value,n.depth+1,child.key FROM nodes n CROSS JOIN LATERAL (
      SELECT value,key FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END)
      UNION ALL SELECT value,NULL::text FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END)
    ) child WHERE n.depth<=36
  ) SELECT count(*),max(depth),COALESCE(bool_or(key_name IN ('__proto__','prototype','constructor')
      OR schedule_private.utf16_length(key_name)>256
      OR CASE WHEN pg_catalog.jsonb_typeof(value)='number' THEN pg_catalog.abs((value #>> '{}')::numeric)>1.7976931348623157e308::numeric ELSE false END),false)
    INTO v_count,v_depth,v_unsafe FROM nodes;
  IF v_count>300000 OR v_depth>36 OR v_unsafe THEN RETURN 'Action contains unsafe properties or excessive structure'; END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_index(p_items jsonb,p_id text,p_key text DEFAULT 'id')
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
  SELECT (ordinality-1)::integer FROM pg_catalog.jsonb_array_elements(p_items) WITH ORDINALITY WHERE value->>p_key=p_id LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_descendants(p_tasks jsonb,p_ids jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_all jsonb:=p_ids; v_frontier jsonb:=p_ids; v_next jsonb; v_level integer:=0;
BEGIN
  -- Breadth-first waves preserve JS Set order and visit a task only once,
  -- even when roots contain both ancestors and descendants. No path explosion.
  LOOP
    SELECT COALESCE(pg_catalog.jsonb_agg(t.value->'id' ORDER BY f.ordinality,t.ordinality),'[]'::jsonb)
      INTO v_next FROM pg_catalog.jsonb_array_elements_text(v_frontier) WITH ORDINALITY f
      JOIN pg_catalog.jsonb_array_elements(p_tasks) WITH ORDINALITY t ON t.value->>'pid'=f.value
      WHERE NOT(v_all ? (t.value->>'id'));
    EXIT WHEN pg_catalog.jsonb_array_length(v_next)=0;
    v_all:=v_all||v_next; v_frontier:=v_next; v_level:=v_level+1;
    IF v_level>128 OR pg_catalog.jsonb_array_length(v_all)>10000 THEN
      PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Task hierarchy exceeds supported size');
    END IF;
  END LOOP;
  RETURN v_all;
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_shift_date(p_date text,p_days integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_date date;
BEGIN
  IF NOT schedule_private.valid_date(p_date) THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid date'); END IF;
  v_date:=p_date::date+p_days;
  IF v_date<'0100-01-01'::date OR v_date>'9999-12-31'::date THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Date shift exceeds supported years'); END IF;
  RETURN pg_catalog.to_char(v_date,'YYYY-MM-DD');
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_definitions()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
  SELECT $definitions$[{"name":"project.update","description":"修改共享排期标题；视图、列宽和折叠属于个人界面状态，不写入共享数据。","inputSchema":{"type":"object","properties":{"patch":{"type":"object","properties":{"title":{"type":"string","maxLength":512}},"required":[],"additionalProperties":false,"minProperties":1}},"required":["patch"],"additionalProperties":false},"destructiveHint":false},{"name":"project.replace","description":"用完整 JSON 导入或恢复排期，替换全部共享内容；须显式传 confirm:true。不会更改排期链接、权限或版本规则。","inputSchema":{"type":"object","properties":{"project":{"type":"object","additionalProperties":true},"confirm":{"const":true}},"required":["project","confirm"],"additionalProperties":false},"destructiveHint":true},{"name":"project.shift","description":"按自然日平移整个排期的全部任务和全局里程碑；正数后移、负数前移。","inputSchema":{"type":"object","properties":{"days":{"type":"integer","minimum":-36500,"maximum":36500}},"required":["days"],"additionalProperties":false},"destructiveHint":false},{"name":"task.add","description":"添加任务、子任务、管线或重要节点。ID 由调用者指定；pid 指向父任务；beforeId 可指定同层插入位置，省略追加。","inputSchema":{"type":"object","properties":{"task":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1},"pid":{"anyOf":[{"type":"string","maxLength":256,"minLength":1},{"type":"null"}]},"name":{"type":"string","maxLength":2048,"minLength":1},"type":{"enum":["task","milestone","pipeline"]},"s":{"type":"string","maxLength":10,"pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"e":{"type":"string","maxLength":10,"pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"pct":{"type":"number","minimum":0,"maximum":100},"who":{"type":"string","maxLength":512},"grp":{"type":"string","maxLength":256},"phase":{"type":"string","maxLength":512},"flow":{"type":"boolean"},"lane":{"type":"integer","minimum":0,"maximum":10000},"customValues":{"type":"object","propertyNames":{"pattern":"^cf_[A-Za-z0-9_-]{1,64}$"},"additionalProperties":{"anyOf":[{"type":"string","maxLength":4096},{"type":"number"},{"type":"boolean"},{"type":"null"}]}},"deps":{"type":"array","items":{"type":"string","maxLength":256,"minLength":1},"maxItems":10000,"uniqueItems":true}},"required":["id","name","s","e"],"additionalProperties":false},"beforeId":{"type":"string","maxLength":256,"minLength":1}},"required":["task"],"additionalProperties":false},"destructiveHint":false},{"name":"task.update","description":"修改任务名称、类型、日期、进度、负责人、职能、阶段、流程泳道或自定义值。patch.customValues 整体替换；局部字段值请用 field.values.set。父任务日期和进度来自子任务，请用 task.shift 平移。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1},"patch":{"type":"object","properties":{"name":{"type":"string","maxLength":2048,"minLength":1},"type":{"enum":["task","milestone","pipeline"]},"s":{"type":"string","maxLength":10,"pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"e":{"type":"string","maxLength":10,"pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"pct":{"type":"number","minimum":0,"maximum":100},"who":{"type":"string","maxLength":512},"grp":{"type":"string","maxLength":256},"phase":{"type":"string","maxLength":512},"flow":{"type":"boolean"},"lane":{"type":"integer","minimum":0,"maximum":10000},"customValues":{"type":"object","propertyNames":{"pattern":"^cf_[A-Za-z0-9_-]{1,64}$"},"additionalProperties":{"anyOf":[{"type":"string","maxLength":4096},{"type":"number"},{"type":"boolean"},{"type":"null"}]}}},"required":[],"additionalProperties":false,"minProperties":1}},"required":["id","patch"],"additionalProperties":false},"destructiveHint":false},{"name":"task.remove","description":"删除指定任务。默认遇到子任务时报错；cascade:true 才会连同所有后代删除。会清理剩余任务指向已删除项的依赖。","inputSchema":{"type":"object","properties":{"ids":{"type":"array","items":{"type":"string","maxLength":256,"minLength":1},"maxItems":10000,"minItems":1,"uniqueItems":true},"cascade":{"type":"boolean","default":false}},"required":["ids"],"additionalProperties":false},"destructiveHint":true},{"name":"task.move","description":"调整父子归属及同层位置。parentId:null 移到顶层；beforeId 省略时移到目标同层最后。不会移动日期。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1},"parentId":{"anyOf":[{"type":"string","maxLength":256,"minLength":1},{"type":"null"}]},"beforeId":{"type":"string","maxLength":256,"minLength":1}},"required":["id","parentId"],"additionalProperties":false},"destructiveHint":false},{"name":"task.reorder","description":"调整指定父级的全部直接子项顺序。ids 必须恰好包含该父级每个子项一次，不改变父子关系。","inputSchema":{"type":"object","properties":{"parentId":{"anyOf":[{"type":"string","maxLength":256,"minLength":1},{"type":"null"}]},"ids":{"type":"array","items":{"type":"string","maxLength":256,"minLength":1},"maxItems":10000,"uniqueItems":true}},"required":["parentId","ids"],"additionalProperties":false},"destructiveHint":false},{"name":"task.shift","description":"按自然日平移所选任务。includeDescendants 默认 true，重叠选择的后代只平移一次；不自动平移依赖任务或全局里程碑。","inputSchema":{"type":"object","properties":{"ids":{"type":"array","items":{"type":"string","maxLength":256,"minLength":1},"maxItems":10000,"minItems":1,"uniqueItems":true},"days":{"type":"integer","minimum":-36500,"maximum":36500},"includeDescendants":{"type":"boolean","default":true}},"required":["ids","days"],"additionalProperties":false},"destructiveHint":false},{"name":"task.duplicate","description":"复制指定任务及其完整子树；idMap 必须为每个原任务提供一个全新 ID。内部依赖重映射，外部依赖保留；parentId 可改变副本根的父级。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1},"idMap":{"type":"object","minProperties":1,"maxProperties":10000,"additionalProperties":{"type":"string","maxLength":256,"minLength":1}},"parentId":{"anyOf":[{"type":"string","maxLength":256,"minLength":1},{"type":"null"}]}},"required":["id","idMap"],"additionalProperties":false},"destructiveHint":false},{"name":"dependency.add","description":"给 taskId 添加前置任务 dependsOn；重复添加不重复写入。拒绝自身、管线及所有显式/隐式依赖环。","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","maxLength":256,"minLength":1},"dependsOn":{"type":"string","maxLength":256,"minLength":1}},"required":["taskId","dependsOn"],"additionalProperties":false},"destructiveHint":false},{"name":"dependency.remove","description":"移除 taskId 的一个前置依赖；不存在的依赖按无变化处理。","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","maxLength":256,"minLength":1},"dependsOn":{"type":"string","maxLength":256,"minLength":1}},"required":["taskId","dependsOn"],"additionalProperties":false},"destructiveHint":false},{"name":"dependency.set","description":"整体替换指定任务的前置依赖列表；空数组表示清空。","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","maxLength":256,"minLength":1},"deps":{"type":"array","items":{"type":"string","maxLength":256,"minLength":1},"maxItems":10000,"uniqueItems":true}},"required":["taskId","deps"],"additionalProperties":false},"destructiveHint":false},{"name":"role.add","description":"添加职能及颜色；已隐藏的默认职能可以重新添加。","inputSchema":{"type":"object","properties":{"name":{"type":"string","maxLength":256,"minLength":1},"color":{"type":"string","maxLength":7,"pattern":"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"}},"required":["name","color"],"additionalProperties":false},"destructiveHint":false},{"name":"role.update","description":"重命名职能或修改颜色；同步更新全部任务的职能引用。","inputSchema":{"type":"object","properties":{"name":{"type":"string","maxLength":256,"minLength":1},"patch":{"type":"object","properties":{"name":{"type":"string","maxLength":256,"minLength":1},"color":{"type":"string","maxLength":7,"pattern":"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"}},"required":[],"additionalProperties":false,"minProperties":1}},"required":["name","patch"],"additionalProperties":false},"destructiveHint":false},{"name":"role.remove","description":"删除职能。仍被任务使用时须提供 replacement（另一现有职能或空字符串），否则拒绝删除。","inputSchema":{"type":"object","properties":{"name":{"type":"string","maxLength":256,"minLength":1},"replacement":{"type":"string","maxLength":256}},"required":["name"],"additionalProperties":false},"destructiveHint":true},{"name":"phase.rename","description":"重命名阶段并同步其所有任务；目标名称已存在时合并两个阶段。新阶段可直接通过 task.update 的 phase 创建。","inputSchema":{"type":"object","properties":{"name":{"type":"string","maxLength":512,"minLength":1},"newName":{"type":"string","maxLength":512,"minLength":1}},"required":["name","newName"],"additionalProperties":false},"destructiveHint":false},{"name":"phase.remove","description":"清除指定阶段的全部任务标签，不删除任务。","inputSchema":{"type":"object","properties":{"name":{"type":"string","maxLength":512,"minLength":1}},"required":["name"],"additionalProperties":false},"destructiveHint":true},{"name":"field.add","description":"添加文本、数字、日期、单选或勾选字段。单选须提供 options；每个字段/选项使用稳定 ID。","inputSchema":{"type":"object","properties":{"field":{"type":"object","properties":{"id":{"type":"string","maxLength":67,"pattern":"^cf_[A-Za-z0-9_-]{1,64}$"},"name":{"type":"string","maxLength":128,"minLength":1},"type":{"enum":["text","number","date","select","checkbox"]},"options":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string","maxLength":67,"pattern":"^fo_[A-Za-z0-9_-]{1,64}$"},"label":{"type":"string","maxLength":128,"minLength":1}},"required":["id","label"],"additionalProperties":false},"maxItems":100,"minItems":1}},"required":["id","name","type"],"additionalProperties":false}},"required":["field"],"additionalProperties":false},"destructiveHint":false},{"name":"field.update","description":"修改字段名称及单选选项。字段类型固定；移除选项会清理任务上该选项的值，其余稳定 ID 不变。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":67,"pattern":"^cf_[A-Za-z0-9_-]{1,64}$"},"patch":{"type":"object","properties":{"name":{"type":"string","maxLength":128,"minLength":1},"options":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string","maxLength":67,"pattern":"^fo_[A-Za-z0-9_-]{1,64}$"},"label":{"type":"string","maxLength":128,"minLength":1}},"required":["id","label"],"additionalProperties":false},"maxItems":100,"minItems":1}},"required":[],"additionalProperties":false,"minProperties":1}},"required":["id","patch"],"additionalProperties":false},"destructiveHint":false},{"name":"field.remove","description":"删除自定义字段及全部任务上该字段的值。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":67,"pattern":"^cf_[A-Za-z0-9_-]{1,64}$"}},"required":["id"],"additionalProperties":false},"destructiveHint":true},{"name":"field.values.set","description":"局部设置一个任务的自定义字段值；未提及的字段保留，null 清除对应值。值类型必须匹配字段定义。","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","maxLength":256,"minLength":1},"values":{"type":"object","propertyNames":{"pattern":"^cf_[A-Za-z0-9_-]{1,64}$"},"additionalProperties":{"anyOf":[{"type":"string","maxLength":4096},{"type":"number"},{"type":"boolean"},{"type":"null"}]}}},"required":["taskId","values"],"additionalProperties":false},"destructiveHint":false},{"name":"flag.add","description":"添加时间轴顶部的全局里程碑（不占任务行）；与 task.type=milestone 的重要节点不同。","inputSchema":{"type":"object","properties":{"flag":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1},"name":{"type":"string","maxLength":2048,"minLength":1},"d":{"type":"string","maxLength":10,"pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"color":{"type":"string","maxLength":7,"pattern":"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"}},"required":["id","name","d"],"additionalProperties":false}},"required":["flag"],"additionalProperties":false},"destructiveHint":false},{"name":"flag.update","description":"修改全局里程碑的名称、日期或颜色。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1},"patch":{"type":"object","properties":{"name":{"type":"string","maxLength":2048,"minLength":1},"d":{"type":"string","maxLength":10,"pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"color":{"type":"string","maxLength":7,"pattern":"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"}},"required":[],"additionalProperties":false,"minProperties":1}},"required":["id","patch"],"additionalProperties":false},"destructiveHint":false},{"name":"flag.remove","description":"删除一个全局里程碑。","inputSchema":{"type":"object","properties":{"id":{"type":"string","maxLength":256,"minLength":1}},"required":["id"],"additionalProperties":false},"destructiveHint":true}]$definitions$::jsonb
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_normalize(p_project jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_project jsonb:=p_project; v_tasks jsonb:='[]'::jsonb; v_items jsonb; v_item jsonb; v_error text; v_meta jsonb; v_key text;
BEGIN
  v_error:=schedule_private.tool_json_error(p_project);
  IF v_error IS NOT NULL THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR',v_error); END IF;
  IF pg_catalog.jsonb_typeof(p_project) IS DISTINCT FROM 'object' OR p_project->>'format'='schedule-gantt-storage'
    OR pg_catalog.jsonb_typeof(p_project->'tasks') IS DISTINCT FROM 'array' THEN
    PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Expected a raw project with tasks array');
  END IF;
  v_project:='{"groups":[],"flags":[],"meta":{}}'::jsonb||v_project;
  v_meta:=v_project->'meta';
  IF pg_catalog.jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid project metadata'); END IF;
  v_meta:=v_meta-ARRAY['cols','lw','leftWidth','paneAuto','layoutVersion','nameAutoWidth','columnOrder','hiddenColumns','defView'];
  v_project:=pg_catalog.jsonb_set(v_project,'{meta}',v_meta);
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_project->'tasks') WHERE pg_catalog.jsonb_typeof(value)<>'object') THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid task object'); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(
    ('{"type":"task","pid":null,"pct":0,"flow":false,"lane":0,"deps":[],"who":"","grp":"","phase":""}'::jsonb||value
      ||CASE WHEN value->>'type'='milestone' AND NOT(value ? 'e') THEN pg_catalog.jsonb_build_object('e',value->'s') ELSE '{}'::jsonb END)
      -ARRAY['fold','collapsed'] ORDER BY ordinality),'[]'::jsonb)
    INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_project->'tasks') WITH ORDINALITY;
  v_project:=pg_catalog.jsonb_set(v_project,'{tasks}',v_tasks);
  FOREACH v_key IN ARRAY ARRAY['groups','flags'] LOOP
    IF pg_catalog.jsonb_typeof(v_project->v_key) IS DISTINCT FROM 'array' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid project array '||v_key); END IF;
    IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_project->v_key) WHERE pg_catalog.jsonb_typeof(value)<>'object') THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid '||v_key||' item'); END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('color',CASE WHEN v_key='groups' THEN '#2f6fe8' ELSE '#e03e3e' END)||value ORDER BY ordinality),'[]'::jsonb)
      INTO v_items FROM pg_catalog.jsonb_array_elements(v_project->v_key) WITH ORDINALITY;
    v_project:=pg_catalog.jsonb_set(v_project,ARRAY[v_key],v_items);
  END LOOP;
  RETURN v_project;
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_insert_before(p_items jsonb,p_item jsonb,p_before text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_index integer;
BEGIN
  IF p_before IS NULL THEN RETURN p_items||pg_catalog.jsonb_build_array(p_item); END IF;
  v_index:=schedule_private.tool_index(p_items,p_before);
  IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','beforeId task not found'); END IF;
  IF p_items->v_index->'pid' IS DISTINCT FROM p_item->'pid' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','beforeId must be a sibling'); END IF;
  RETURN pg_catalog.jsonb_insert(p_items,ARRAY[v_index::text],p_item,false);
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_check_field(p_field jsonb,p_fields jsonb,p_except text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE v_name text:=schedule_private.js_trim(p_field->>'name'); v_option jsonb; v_seen text[]:=ARRAY[]::text[];
BEGIN
  IF v_name='' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Field name cannot be blank'); END IF;
  IF pg_catalog.lower(v_name)=ANY(ARRAY['名称','负责人','开始','结束','进度','职能','阶段'])
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(p_fields) WHERE (p_except IS NULL OR value->>'id'<>p_except) AND pg_catalog.lower(value->>'name')=pg_catalog.lower(v_name)) THEN
    PERFORM schedule_private.tool_reject('ITEM_EXISTS','Field name already exists');
  END IF;
  IF p_field->>'type'='select' THEN
    IF pg_catalog.jsonb_typeof(p_field->'options') IS DISTINCT FROM 'array' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Select field requires options'); END IF;
    IF pg_catalog.jsonb_array_length(p_field->'options')=0 THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Select field requires at least one option'); END IF;
    FOR v_option IN SELECT value FROM pg_catalog.jsonb_array_elements(p_field->'options') LOOP
      v_name:=schedule_private.js_trim(v_option->>'label');
      IF v_name='' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Option label cannot be blank'); END IF;
      IF pg_catalog.lower(v_name)=ANY(v_seen) THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Option label already exists'); END IF;
      v_seen:=pg_catalog.array_append(v_seen,pg_catalog.lower(v_name));
    END LOOP;
  ELSIF p_field ? 'options' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Only select fields have options');
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION schedule_private.tool_apply(p_project jsonb,p_operations jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $function$
DECLARE
  v_project jsonb:=schedule_private.tool_normalize(p_project); v_original jsonb;
  v_op jsonb; v_args jsonb; v_name text; v_schema jsonb; v_error text; v_code text;
  v_tasks jsonb; v_groups jsonb; v_flags jsonb; v_fields jsonb; v_meta jsonb;
  v_results jsonb:='[]'::jsonb; v_affected jsonb; v_item jsonb; v_patch jsonb; v_old jsonb;
  v_ids jsonb; v_desc jsonb; v_map jsonb; v_array jsonb; v_temp jsonb; v_pair record;
  v_id text; v_parent text; v_before text; v_new_name text; v_old_name text; v_replacement text;
  v_index integer; v_j integer; v_days integer; v_operation_index integer:=-1; v_count integer;
BEGIN
  v_original:=v_project;
  IF pg_catalog.jsonb_typeof(p_operations) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_operations) NOT BETWEEN 1 AND 100 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','operations must contain 1 to 100 actions');
  END IF;
  FOR v_op IN SELECT value FROM pg_catalog.jsonb_array_elements(p_operations) LOOP
    v_operation_index:=v_operation_index+1;
    BEGIN
      IF pg_catalog.jsonb_typeof(v_op) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(v_op->'name') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(v_op->'arguments') IS DISTINCT FROM 'object'
        OR v_op-ARRAY['name','arguments']<>'{}'::jsonb THEN
        PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Each operation must contain name and arguments');
      END IF;
      v_name:=v_op->>'name'; v_args:=v_op->'arguments'; v_affected:='[]'::jsonb;
      SELECT value->'inputSchema' INTO v_schema FROM pg_catalog.jsonb_array_elements(schedule_private.tool_definitions()) WHERE value->>'name'=v_name;
      IF NOT FOUND THEN PERFORM schedule_private.tool_reject('UNKNOWN_OPERATION','Unknown operation: '||v_name); END IF;
      v_error:=schedule_private.tool_schema_error(v_args,v_schema);
      IF v_error IS NOT NULL THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR',v_error); END IF;
      v_tasks:=v_project->'tasks'; v_groups:=v_project->'groups'; v_flags:=v_project->'flags';
      v_meta:=v_project->'meta'; v_fields:=COALESCE(v_meta->'customFields','[]'::jsonb);

      CASE v_name
      WHEN 'project.update' THEN
        v_meta:=v_meta||(v_args->'patch');
      WHEN 'project.replace' THEN
        v_project:=schedule_private.tool_normalize(v_args->'project');
        v_error:=schedule_private.validate_project(v_project);
        IF v_error IS NOT NULL THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR',v_error); END IF;
        v_tasks:=v_project->'tasks'; v_groups:=v_project->'groups'; v_flags:=v_project->'flags'; v_meta:=v_project->'meta';
      WHEN 'project.shift' THEN
        v_days:=(v_args->>'days')::integer;
        SELECT COALESCE(pg_catalog.jsonb_agg(value||pg_catalog.jsonb_build_object('s',schedule_private.tool_shift_date(value->>'s',v_days),'e',schedule_private.tool_shift_date(value->>'e',v_days)) ORDER BY ordinality),'[]'::jsonb)
          INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        SELECT COALESCE(pg_catalog.jsonb_agg(value||pg_catalog.jsonb_build_object('d',schedule_private.tool_shift_date(value->>'d',v_days)) ORDER BY ordinality),'[]'::jsonb)
          INTO v_flags FROM pg_catalog.jsonb_array_elements(v_flags) WITH ORDINALITY;
      WHEN 'task.add' THEN
        v_item:='{"type":"task","pid":null,"pct":0,"flow":false,"lane":0,"deps":[],"who":"","grp":"","phase":""}'::jsonb||(v_args->'task');
        v_id:=v_item->>'id';
        IF schedule_private.tool_index(v_tasks,v_id) IS NOT NULL THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Task ID already exists'); END IF;
        -- Parent/dependency forward references can be resolved later in a batch.
        v_tasks:=schedule_private.tool_insert_before(v_tasks,v_item,v_args->>'beforeId');
        v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'task.update' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_tasks,v_id); v_patch:=v_args->'patch';
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found'); END IF;
        IF v_patch ?| ARRAY['s','e','pct'] AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_tasks) WHERE value->>'pid'=v_id) THEN
          PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Summary dates and progress derive from descendants; use task.shift');
        END IF;
        v_tasks:=pg_catalog.jsonb_set(v_tasks,ARRAY[v_index::text],(v_tasks->v_index)||v_patch);
        v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'task.remove' THEN
        v_ids:=v_args->'ids';
        FOR v_id IN SELECT value FROM pg_catalog.jsonb_array_elements_text(v_ids) LOOP
          IF schedule_private.tool_index(v_tasks,v_id) IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found: '||v_id); END IF;
        END LOOP;
        v_desc:=schedule_private.tool_descendants(v_tasks,v_ids);
        IF COALESCE(v_args->'cascade','false'::jsonb)<>'true'::jsonb AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_desc) WHERE NOT(v_ids ? value)) THEN
          PERFORM schedule_private.tool_reject('ITEM_IN_USE','Task has descendants; pass cascade:true');
        END IF;
        v_affected:=v_desc;
        SELECT COALESCE(pg_catalog.jsonb_agg(value||pg_catalog.jsonb_build_object('deps',(SELECT COALESCE(pg_catalog.jsonb_agg(d.value ORDER BY d.ordinality),'[]'::jsonb)
          FROM pg_catalog.jsonb_array_elements(value->'deps') WITH ORDINALITY d WHERE NOT(v_desc ? (d.value #>> '{}')))) ORDER BY ordinality),'[]'::jsonb)
          INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY WHERE NOT(v_desc ? (value->>'id'));
      WHEN 'task.move' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_tasks,v_id); v_parent:=v_args->>'parentId'; v_before:=v_args->>'beforeId';
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found'); END IF;
        v_item:=v_tasks->v_index;
        IF v_item->>'type'='pipeline' AND v_parent IS NOT NULL THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Pipeline must remain top level'); END IF;
        v_desc:=schedule_private.tool_descendants(v_tasks,pg_catalog.jsonb_build_array(v_id));
        IF v_parent IS NOT NULL THEN
          v_j:=schedule_private.tool_index(v_tasks,v_parent);
          IF v_j IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Parent task not found'); END IF;
          IF v_desc ? v_parent OR v_tasks->v_j->>'type'='milestone' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid task parent'); END IF;
        END IF;
        IF v_before=v_id OR v_desc ? v_before THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Cannot position task inside its subtree'); END IF;
        v_item:=v_item||pg_catalog.jsonb_build_object('pid',v_args->'parentId');
        v_tasks:=schedule_private.tool_insert_before(v_tasks-v_index,v_item,v_before);
        v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'task.reorder' THEN
        v_ids:=v_args->'ids';
        IF v_args->>'parentId' IS NOT NULL THEN
          v_index:=schedule_private.tool_index(v_tasks,v_args->>'parentId');
          IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Parent task not found'); END IF;
          IF v_tasks->v_index->>'type'='milestone' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Milestone cannot have children'); END IF;
        END IF;
        SELECT COALESCE(pg_catalog.jsonb_agg(value->'id' ORDER BY ordinality),'[]'::jsonb) INTO v_desc
          FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY WHERE value->'pid'=v_args->'parentId';
        IF pg_catalog.jsonb_array_length(v_desc)<>pg_catalog.jsonb_array_length(v_ids) OR NOT(v_desc @> v_ids) THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','ids must contain every sibling exactly once'); END IF;
        v_array:='[]'::jsonb; v_j:=0;
        FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_tasks) LOOP
          IF v_item->'pid'=v_args->'parentId' THEN
            v_item:=v_tasks->schedule_private.tool_index(v_tasks,v_ids->>v_j); v_j:=v_j+1;
          END IF;
          v_array:=v_array||pg_catalog.jsonb_build_array(v_item);
        END LOOP;
        v_tasks:=v_array; v_affected:=v_ids;
      WHEN 'task.shift' THEN
        v_ids:=v_args->'ids'; v_days:=(v_args->>'days')::integer;
        FOR v_id IN SELECT value FROM pg_catalog.jsonb_array_elements_text(v_ids) LOOP
          IF schedule_private.tool_index(v_tasks,v_id) IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found: '||v_id); END IF;
        END LOOP;
        v_desc:=CASE WHEN v_args->'includeDescendants'='false'::jsonb THEN v_ids ELSE schedule_private.tool_descendants(v_tasks,v_ids) END;
        SELECT COALESCE(pg_catalog.jsonb_agg(CASE WHEN v_desc ? (value->>'id') THEN value||pg_catalog.jsonb_build_object('s',schedule_private.tool_shift_date(value->>'s',v_days),'e',schedule_private.tool_shift_date(value->>'e',v_days)) ELSE value END ORDER BY ordinality),'[]'::jsonb)
          INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        v_affected:=v_desc;
      WHEN 'task.duplicate' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_tasks,v_id); v_map:=v_args->'idMap';
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found'); END IF;
        v_desc:=schedule_private.tool_descendants(v_tasks,pg_catalog.jsonb_build_array(v_id));
        IF (SELECT count(*) FROM pg_catalog.jsonb_each(v_map))<>pg_catalog.jsonb_array_length(v_desc)
          OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_desc) WHERE NOT(v_map ? value)) THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','idMap must map exactly the entire subtree'); END IF;
        IF (SELECT count(DISTINCT value) FROM pg_catalog.jsonb_each(v_map))<>pg_catalog.jsonb_array_length(v_desc) THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Duplicated task IDs must be unique'); END IF;
        FOR v_pair IN SELECT * FROM pg_catalog.jsonb_each_text(v_map) LOOP
          IF schedule_private.tool_index(v_tasks,v_pair.value) IS NOT NULL THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Duplicate target ID already exists'); END IF;
        END LOOP;
        v_parent:=CASE WHEN v_args ? 'parentId' THEN v_args->>'parentId' ELSE v_tasks->v_index->>'pid' END;
        IF v_parent IS NOT NULL THEN
          v_j:=schedule_private.tool_index(v_tasks,v_parent);
          IF v_j IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Parent task not found'); END IF;
          IF v_tasks->v_j->>'type'='milestone' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Milestone cannot have children'); END IF;
        END IF;
        v_array:='[]'::jsonb; v_affected:='[]'::jsonb;
        FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_tasks) WHERE v_desc ? (value->>'id') LOOP
          v_old:=v_item;
          v_item:=v_item||pg_catalog.jsonb_build_object('id',v_map->(v_item->>'id'));
          IF v_old->>'id'=v_id THEN
            IF v_args ? 'parentId' THEN v_item:=v_item||pg_catalog.jsonb_build_object('pid',v_args->'parentId'); END IF;
          ELSE v_item:=v_item||pg_catalog.jsonb_build_object('pid',v_map->(v_old->>'pid'));
          END IF;
          SELECT COALESCE(pg_catalog.jsonb_agg(COALESCE(v_map->(value #>> '{}'),value) ORDER BY ordinality),'[]'::jsonb) INTO v_temp FROM pg_catalog.jsonb_array_elements(v_old->'deps') WITH ORDINALITY;
          v_item:=v_item||pg_catalog.jsonb_build_object('deps',v_temp);
          v_array:=v_array||pg_catalog.jsonb_build_array(v_item); v_affected:=v_affected||pg_catalog.jsonb_build_array(v_item->'id');
        END LOOP;
        v_tasks:=v_tasks||v_array;
      WHEN 'dependency.add','dependency.remove','dependency.set' THEN
        v_id:=v_args->>'taskId'; v_index:=schedule_private.tool_index(v_tasks,v_id);
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found'); END IF;
        v_item:=v_tasks->v_index;
        IF v_name='dependency.set' THEN v_ids:=v_args->'deps';
        ELSE
          v_ids:=v_item->'deps';
          IF v_name='dependency.add' THEN
            IF schedule_private.tool_index(v_tasks,v_args->>'dependsOn') IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Dependency task not found'); END IF;
            IF NOT(v_ids ? (v_args->>'dependsOn')) THEN v_ids:=v_ids||pg_catalog.jsonb_build_array(v_args->'dependsOn'); END IF;
          ELSE SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO v_ids FROM pg_catalog.jsonb_array_elements(v_ids) WITH ORDINALITY WHERE value<>v_args->'dependsOn';
          END IF;
        END IF;
        v_tasks:=pg_catalog.jsonb_set(v_tasks,ARRAY[v_index::text],v_item||pg_catalog.jsonb_build_object('deps',v_ids));
        v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'role.add' THEN
        v_new_name:=v_args->>'name';
        IF schedule_private.js_trim(v_new_name)='' OR v_new_name=ANY(ARRAY['__proto__','prototype','constructor']) THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid role name'); END IF;
        IF schedule_private.tool_index(v_groups,v_new_name,'name') IS NOT NULL THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Role already exists'); END IF;
        v_item:=pg_catalog.jsonb_build_object('name',v_new_name,'color',v_args->>'color');
        v_groups:=v_groups||pg_catalog.jsonb_build_array(v_item);
        v_meta:=v_meta||pg_catalog.jsonb_build_object('roleColors',COALESCE(v_meta->'roleColors','{}'::jsonb)||pg_catalog.jsonb_build_object(v_new_name,v_item->'color'));
        IF v_meta ? 'hiddenRoles' THEN
          SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO v_array FROM pg_catalog.jsonb_array_elements(v_meta->'hiddenRoles') WITH ORDINALITY WHERE value<>pg_catalog.to_jsonb(v_new_name);
          v_meta:=v_meta||pg_catalog.jsonb_build_object('hiddenRoles',v_array);
        END IF;
        v_affected:=pg_catalog.jsonb_build_array(v_new_name);
      WHEN 'role.update' THEN
        v_old_name:=v_args->>'name'; v_index:=schedule_private.tool_index(v_groups,v_old_name,'name'); v_patch:=v_args->'patch';
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Role not found'); END IF;
        v_new_name:=CASE WHEN v_patch ? 'name' THEN v_patch->>'name' ELSE v_old_name END;
        IF schedule_private.js_trim(v_new_name)='' OR v_new_name=ANY(ARRAY['__proto__','prototype','constructor']) THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid role name'); END IF;
        IF v_new_name<>v_old_name AND schedule_private.tool_index(v_groups,v_new_name,'name') IS NOT NULL THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Role already exists'); END IF;
        v_item:=(v_groups->v_index)||pg_catalog.jsonb_build_object('name',v_new_name);
        IF v_patch ? 'color' THEN v_item:=v_item||pg_catalog.jsonb_build_object('color',v_patch->>'color'); END IF;
        v_groups:=pg_catalog.jsonb_set(v_groups,ARRAY[v_index::text],v_item);
        SELECT COALESCE(pg_catalog.jsonb_agg(CASE WHEN value->>'grp'=v_old_name THEN value||pg_catalog.jsonb_build_object('grp',v_new_name) ELSE value END ORDER BY ordinality),'[]'::jsonb) INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        IF v_new_name<>v_old_name THEN
          IF v_old_name=ANY(ARRAY['策划','美术','程序','技术策划','技术美术','动画']) THEN
            v_array:=COALESCE(v_meta->'hiddenRoles','[]'::jsonb);
            IF NOT(v_array ? v_old_name) THEN v_array:=v_array||pg_catalog.jsonb_build_array(v_old_name); END IF;
            v_meta:=v_meta||pg_catalog.jsonb_build_object('hiddenRoles',v_array);
          END IF;
          IF v_meta ? 'hiddenRoles' THEN
            SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO v_array FROM pg_catalog.jsonb_array_elements(v_meta->'hiddenRoles') WITH ORDINALITY WHERE value<>pg_catalog.to_jsonb(v_new_name);
            v_meta:=v_meta||pg_catalog.jsonb_build_object('hiddenRoles',v_array);
          END IF;
        END IF;
        v_meta:=v_meta||pg_catalog.jsonb_build_object('roleColors',(COALESCE(v_meta->'roleColors','{}'::jsonb)-v_old_name)||pg_catalog.jsonb_build_object(v_new_name,v_item->'color'));
        v_affected:=pg_catalog.jsonb_build_array(v_new_name);
      WHEN 'role.remove' THEN
        v_old_name:=v_args->>'name'; v_index:=schedule_private.tool_index(v_groups,v_old_name,'name'); v_replacement:=v_args->>'replacement';
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Role not found'); END IF;
        IF v_replacement=v_old_name THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Replacement role cannot be removed role'); END IF;
        IF v_replacement IS NOT NULL AND v_replacement<>'' AND schedule_private.tool_index(v_groups,v_replacement,'name') IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Replacement role not found'); END IF;
        IF NOT(v_args ? 'replacement') AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_tasks) WHERE value->>'grp'=v_old_name) THEN PERFORM schedule_private.tool_reject('ITEM_IN_USE','Role is in use; provide replacement'); END IF;
        SELECT COALESCE(pg_catalog.jsonb_agg(CASE WHEN value->>'grp'=v_old_name THEN value||pg_catalog.jsonb_build_object('grp',COALESCE(v_replacement,'')) ELSE value END ORDER BY ordinality),'[]'::jsonb) INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        v_groups:=v_groups-v_index;
        IF v_old_name=ANY(ARRAY['策划','美术','程序','技术策划','技术美术','动画']) THEN
          v_array:=COALESCE(v_meta->'hiddenRoles','[]'::jsonb);
          IF NOT(v_array ? v_old_name) THEN v_array:=v_array||pg_catalog.jsonb_build_array(v_old_name); END IF;
          v_meta:=v_meta||pg_catalog.jsonb_build_object('hiddenRoles',v_array);
        END IF;
        v_meta:=v_meta||pg_catalog.jsonb_build_object('roleColors',COALESCE(v_meta->'roleColors','{}'::jsonb)-v_old_name);
        v_affected:=pg_catalog.jsonb_build_array(v_old_name);
      WHEN 'phase.rename','phase.remove' THEN
        v_old_name:=v_args->>'name'; v_new_name:=CASE WHEN v_name='phase.rename' THEN v_args->>'newName' ELSE '' END;
        IF v_name='phase.rename' AND schedule_private.js_trim(v_new_name)='' THEN PERFORM schedule_private.tool_reject('VALIDATION_ERROR','Invalid phase name'); END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_tasks) WHERE value->>'phase'=v_old_name) THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Phase not found'); END IF;
        SELECT COALESCE(pg_catalog.jsonb_agg(CASE WHEN value->>'phase'=v_old_name THEN value||pg_catalog.jsonb_build_object('phase',v_new_name) ELSE value END ORDER BY ordinality),'[]'::jsonb) INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        v_affected:=pg_catalog.jsonb_build_array(v_old_name);
      WHEN 'field.add' THEN
        v_item:=v_args->'field'; v_id:=v_item->>'id';
        IF schedule_private.tool_index(v_fields,v_id) IS NOT NULL THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Field ID already exists'); END IF;
        v_item:=v_item||pg_catalog.jsonb_build_object('name',schedule_private.js_trim(v_item->>'name'));
        IF v_item ? 'options' THEN
          SELECT COALESCE(pg_catalog.jsonb_agg(value||pg_catalog.jsonb_build_object('label',schedule_private.js_trim(value->>'label')) ORDER BY ordinality),'[]'::jsonb) INTO v_array FROM pg_catalog.jsonb_array_elements(v_item->'options') WITH ORDINALITY;
          v_item:=v_item||pg_catalog.jsonb_build_object('options',v_array);
        END IF;
        PERFORM schedule_private.tool_check_field(v_item,v_fields);
        v_meta:=v_meta||pg_catalog.jsonb_build_object('customFields',v_fields||pg_catalog.jsonb_build_array(v_item)); v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'field.update' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_fields,v_id);
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Field not found'); END IF;
        v_patch:=v_args->'patch'; v_old:=v_fields->v_index; v_item:=v_old||v_patch;
        v_item:=v_item||pg_catalog.jsonb_build_object('name',schedule_private.js_trim(v_item->>'name'));
        IF v_item ? 'options' THEN
          SELECT COALESCE(pg_catalog.jsonb_agg(value||pg_catalog.jsonb_build_object('label',schedule_private.js_trim(value->>'label')) ORDER BY ordinality),'[]'::jsonb) INTO v_array FROM pg_catalog.jsonb_array_elements(v_item->'options') WITH ORDINALITY;
          v_item:=v_item||pg_catalog.jsonb_build_object('options',v_array);
        END IF;
        PERFORM schedule_private.tool_check_field(v_item,v_fields,v_id);
        IF v_patch ? 'options' AND v_old->>'type'='select' THEN
          SELECT COALESCE(pg_catalog.jsonb_agg(value->'id'),'[]'::jsonb) INTO v_ids FROM pg_catalog.jsonb_array_elements(v_item->'options');
          SELECT COALESCE(pg_catalog.jsonb_agg(CASE WHEN value->'customValues' ? v_id AND NOT(COALESCE(v_ids ? (value->'customValues'->>v_id),false))
            THEN pg_catalog.jsonb_set(value,'{customValues}',(value->'customValues')-v_id) ELSE value END ORDER BY ordinality),'[]'::jsonb) INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        END IF;
        v_meta:=v_meta||pg_catalog.jsonb_build_object('customFields',pg_catalog.jsonb_set(v_fields,ARRAY[v_index::text],v_item)); v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'field.remove' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_fields,v_id);
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Field not found'); END IF;
        v_meta:=v_meta||pg_catalog.jsonb_build_object('customFields',v_fields-v_index);
        SELECT COALESCE(pg_catalog.jsonb_agg(CASE WHEN value ? 'customValues' THEN pg_catalog.jsonb_set(value,'{customValues}',(value->'customValues')-v_id) ELSE value END ORDER BY ordinality),'[]'::jsonb) INTO v_tasks FROM pg_catalog.jsonb_array_elements(v_tasks) WITH ORDINALITY;
        v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'field.values.set' THEN
        v_id:=v_args->>'taskId'; v_index:=schedule_private.tool_index(v_tasks,v_id);
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Task not found'); END IF;
        v_item:=v_tasks->v_index; v_map:=COALESCE(v_item->'customValues','{}'::jsonb);
        FOR v_pair IN SELECT * FROM pg_catalog.jsonb_each(v_args->'values') LOOP
          IF schedule_private.tool_index(v_fields,v_pair.key) IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Field not found: '||v_pair.key); END IF;
          IF v_pair.value='null'::jsonb THEN v_map:=v_map-v_pair.key; ELSE v_map:=v_map||pg_catalog.jsonb_build_object(v_pair.key,v_pair.value); END IF;
        END LOOP;
        v_tasks:=pg_catalog.jsonb_set(v_tasks,ARRAY[v_index::text],v_item||pg_catalog.jsonb_build_object('customValues',v_map)); v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'flag.add' THEN
        v_item:=pg_catalog.jsonb_build_object('color','#e03e3e')||(v_args->'flag'); v_id:=v_item->>'id';
        IF schedule_private.tool_index(v_flags,v_id) IS NOT NULL THEN PERFORM schedule_private.tool_reject('ITEM_EXISTS','Flag ID already exists'); END IF;
        v_flags:=v_flags||pg_catalog.jsonb_build_array(v_item); v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'flag.update' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_flags,v_id);
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Flag not found'); END IF;
        v_item:=(v_flags->v_index)||(v_args->'patch');
        v_flags:=pg_catalog.jsonb_set(v_flags,ARRAY[v_index::text],v_item); v_affected:=pg_catalog.jsonb_build_array(v_id);
      WHEN 'flag.remove' THEN
        v_id:=v_args->>'id'; v_index:=schedule_private.tool_index(v_flags,v_id);
        IF v_index IS NULL THEN PERFORM schedule_private.tool_reject('ITEM_NOT_FOUND','Flag not found'); END IF;
        v_flags:=v_flags-v_index; v_affected:=pg_catalog.jsonb_build_array(v_id);
      ELSE PERFORM schedule_private.tool_reject('UNKNOWN_OPERATION','Unknown operation');
      END CASE;
      v_project:=v_project||pg_catalog.jsonb_build_object('tasks',v_tasks,'groups',v_groups,'flags',v_flags,'meta',v_meta);
      v_results:=v_results||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',v_operation_index,'name',v_name,'affectedIds',v_affected));
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT,v_code=PG_EXCEPTION_DETAIL;
      RETURN schedule_private.failure(v_code,v_error)||pg_catalog.jsonb_build_object('operationIndex',v_operation_index);
    WHEN OTHERS THEN
      RETURN schedule_private.failure('VALIDATION_ERROR','Invalid action value')||pg_catalog.jsonb_build_object('operationIndex',v_operation_index);
    END;
  END LOOP;
  v_error:=schedule_private.validate_project(v_project);
  IF v_error IS NOT NULL THEN RETURN schedule_private.failure('VALIDATION_ERROR',v_error)||pg_catalog.jsonb_build_object('operationIndex',v_operation_index); END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'project',v_project,'results',v_results,'changed',v_project<>v_original);
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_apply_action(p_id text,p_token text,p_expected_revision integer,p_action jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_authorization jsonb; v_row schedule_private.projects; v_session schedule_private.sessions;
  v_operations jsonb; v_result jsonb; v_error text; v_data jsonb;
BEGIN
  -- This helper reserves the independent external budget and locks project
  -- before session. Key reset/revoke follows the same lock order.
  v_authorization:=schedule_private.authorize_external(p_id,p_token);
  IF v_authorization IS NOT NULL THEN RETURN v_authorization; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<1 OR p_expected_revision=2147483647 THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','Invalid expected revision');
  END IF;
  SELECT * INTO v_row FROM schedule_private.projects WHERE id=p_id;
  IF NOT FOUND THEN RETURN schedule_private.failure('NOT_FOUND','Project not found'); END IF;
  IF v_row.revision<>p_expected_revision THEN
    RETURN schedule_private.failure('REVISION_CONFLICT','Project changed; read the latest revision before retrying')
      ||pg_catalog.jsonb_build_object('latest',schedule_private.public_record(v_row));
  END IF;
  SELECT * INTO v_session FROM schedule_private.sessions
    WHERE token_hash=schedule_private.token_digest(p_token) AND project_id=p_id AND source='external';
  IF NOT FOUND OR v_session.expires_at<=pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','External session expired'); END IF;

  -- Keep parsing/application in its own exception scope. A rejected payload
  -- cannot roll back the already-reserved request budget in the outer scope.
  BEGIN
    v_error:=schedule_private.tool_json_error(p_action);
    IF v_error IS NOT NULL THEN RETURN schedule_private.failure('VALIDATION_ERROR',v_error); END IF;
    IF pg_catalog.jsonb_typeof(p_action) IS DISTINCT FROM 'object' THEN RETURN schedule_private.failure('VALIDATION_ERROR','Action must be an object'); END IF;
    IF p_action ? 'operations' THEN
      IF p_action-'operations'<>'{}'::jsonb THEN RETURN schedule_private.failure('VALIDATION_ERROR','Unknown batch property'); END IF;
      v_operations:=p_action->'operations';
    ELSE v_operations:=pg_catalog.jsonb_build_array(p_action);
    END IF;
    v_result:=schedule_private.tool_apply(v_row.project,v_operations);
    IF v_result->'ok' IS DISTINCT FROM 'true'::jsonb THEN RETURN v_result; END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN schedule_private.failure('VALIDATION_ERROR','Invalid project or action structure');
  END;

  IF v_session.expires_at<=pg_catalog.clock_timestamp() THEN RETURN schedule_private.failure('UNAUTHORIZED','External session expired'); END IF;
  IF v_result->'changed'='true'::jsonb THEN
    UPDATE schedule_private.projects p SET project=v_result->'project',revision=p.revision+1,
      updated_at=pg_catalog.clock_timestamp(),updated_by=v_session.display_name,source='external'
      WHERE p.id=p_id AND p.revision=p_expected_revision AND EXISTS(
        SELECT 1 FROM schedule_private.sessions s WHERE s.project_id=p_id
          AND s.token_hash=schedule_private.token_digest(p_token) AND s.source='external'
          AND s.expires_at>pg_catalog.clock_timestamp()
      ) RETURNING p.* INTO v_row;
    IF NOT FOUND THEN RETURN schedule_private.failure('UNAUTHORIZED','External session expired'); END IF;
  END IF;
  v_data:=schedule_private.public_record(v_row)||pg_catalog.jsonb_build_object('results',v_result->'results','changed',v_result->'changed');
  RETURN pg_catalog.jsonb_build_object('ok',true,'data',v_data);
END
$function$;

ALTER FUNCTION public.schedule_apply_action(text,text,integer,jsonb) OWNER TO CURRENT_USER;
REVOKE ALL ON SCHEMA schedule_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA schedule_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA schedule_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.schedule_apply_action(text,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_apply_action(text,text,integer,jsonb) TO anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
