/* Sample data */
function sample(){
  const T=todayD(), d=o=>fD(T+o);
  const mk=(k,o)=>({id:'s_'+k,...o});
  return { tasks:[
    mk('pro',{name:'原型制作',pid:null,type:'task',s:d(0),e:d(13),pct:0,who:'张三',grp:'策划',phase:'原型阶段',deps:[],fold:false}),
    mk('atk',{name:'攻击模块',pid:'s_pro',type:'task',s:d(0),e:d(6),pct:60,who:'张三',grp:'策划',phase:'原型阶段',deps:[]}),
    mk('mov',{name:'移动模块',pid:'s_pro',type:'task',s:d(7),e:d(12),pct:20,who:'李四',grp:'策划',phase:'原型阶段',deps:['s_atk']}),
    mk('acc',{name:'原型验收',pid:'s_pro',type:'milestone',s:d(13),e:d(13),pct:0,who:'王五',grp:'策划',phase:'原型阶段',deps:['s_mov']}),
    mk('dev',{name:'开发实现',pid:null,type:'task',s:d(14),e:d(31),pct:0,who:'',grp:'程序',phase:'正式化开发',deps:[],fold:false}),
    mk('fe',{name:'角色动画',pid:'s_dev',type:'task',s:d(14),e:d(27),pct:0,who:'赵六',grp:'动画',phase:'正式化开发',deps:['s_acc']}),
    mk('be',{name:'战斗逻辑',pid:'s_dev',type:'task',s:d(14),e:d(31),pct:0,who:'钱七',grp:'技术策划',phase:'正式化开发',deps:['s_acc']}),
    mk('tst',{name:'特效与打磨',pid:null,type:'task',s:d(28),e:d(38),pct:0,who:'孙八',grp:'技术美术',phase:'正式化开发',deps:['s_fe','s_be']}),
    mk('rel',{name:'版本封板',pid:null,type:'milestone',s:d(40),e:d(40),pct:0,who:'',grp:'策划',phase:'正式化开发',deps:['s_tst']})
  ],groups:GROUPS.slice(),flags:[{id:'s_flag1',name:'一测节点',d:d(20),color:'#e03e3e'}],meta:{lw:440}};
}

// Data helpers
const byId  = id => proj.tasks.find(t=>t.id===id);
const kids  = id => proj.tasks.filter(t=>t.pid===id);
const isSum = t  => proj.tasks.some(c=>c.pid===t.id);
const gc    = n  => (proj.groups.find(g=>g.name===n)||{}).color||'#6b7280';
function desc(id,a=[]){for(const c of kids(id)){a.push(c);desc(c.id,a)}return a}
function eRange(t){
  if(!isSum(t))return{s:tD(t.s),e:tD(t.e)};
  // 只按真正的叶子后代（含里程碑）汇总，忽略中间层父任务的过时存储日期
  const ks=desc(t.id).filter(k=>!isSum(k));let s=Infinity,e=-Infinity;
  for(const k of ks){s=Math.min(s,tD(k.s));e=Math.max(e,tD(k.e))}
  return s===Infinity?{s:tD(t.s),e:tD(t.e)}:{s,e};
}
function sumPct(t){
  const lv=desc(t.id).filter(k=>!isSum(k)&&k.type!=='milestone');
  let sm=0,dr=0;for(const k of lv){const w=Math.max(1,tD(k.e)-tD(k.s)+1);dr+=w;sm+=w*(k.pct||0)}
  return dr?Math.round(sm/dr):0;
}
function filteredTaskIds(){
  if(!filterQ&&!filterGrp&&!filterPhase)return null;
  const keep=new Set(),q=filterQ.toLowerCase();
  const hit=t=>{
    if(filterGrp&&(t.type==='pipeline'||t.grp!==filterGrp))return false;
    if(filterPhase&&t.phase!==filterPhase)return false;
    if(q&&!((t.name||'').toLowerCase().includes(q)||(t.who||'').toLowerCase().includes(q)||(t.phase||'').toLowerCase().includes(q)))return false;
    return true;
  };
  for(const t of proj.tasks){
    if(!hit(t))continue;
    keep.add(t.id);
    let p=t.pid;while(p){keep.add(p);p=(byId(p)||{}).pid}
    if(!filterGrp&&!filterPhase)for(const d of desc(t.id))keep.add(d.id);
  }
  return keep;
}
function vRows(){
  const o=[],keep=filteredTaskIds();
  const w=(pid,dp)=>{for(const t of kids(pid)){if(keep&&!keep.has(t.id))continue;o.push({t,depth:dp});if(isSum(t)&&(keep||!t.fold||(typeof ScheduleHighlights!=='undefined'&&ScheduleHighlights.revealsChildren?.(t.id)))&&!t.flow)w(t.id,dp+1)}};
  w(null,0);return o;
}

// Analysis
// 父任务拆成入口/出口屏障，不重复计算工期；重要节点作为零工期活动保留依赖链。
let critEdges=new Set(),dependencyCycleWarned=false;
function dependencyKey(from,to){return JSON.stringify([from,to])}
function isCriticalDep(from,to){return critEdges.has(dependencyKey(from,to))}
function buildDependencyGraph(tasks=proj.tasks,replacement=null){
  const tasksById=new Map(tasks.map(t=>[t.id,t])),children=new Map();
  const entry=new Map(),exit=new Map(),nodes=[],adj=[],edges=[];
  const node=()=>{const id=nodes.length;nodes.push(id);adj.push([]);return id};
  const edge=(from,to,weight=0,dep=null)=>{const e={from,to,weight,dep};adj[from].push(e);edges.push(e)};
  for(const t of tasks){entry.set(t.id,node());exit.set(t.id,node());if(t.pid&&tasksById.has(t.pid)){if(!children.has(t.pid))children.set(t.pid,[]);children.get(t.pid).push(t)}}
  for(const t of tasks){
    const cs=children.get(t.id)||[];
    if(cs.length){for(const c of cs){edge(entry.get(t.id),entry.get(c.id));edge(exit.get(c.id),exit.get(t.id))}}
    else{
      const days=t.type==='milestone'||t.type==='pipeline'?0:Math.max(1,tD(t.e)-tD(t.s)+1);
      edge(entry.get(t.id),exit.get(t.id),Number.isFinite(days)?days:1);
    }
    if(t.type==='pipeline')continue;
    const deps=replacement&&replacement.id===t.id?replacement.deps:(t.deps||[]);
    for(const id of deps){const before=tasksById.get(id);if(before&&before.type!=='pipeline')edge(exit.get(id),entry.get(t.id),0,{from:id,to:t.id})}
  }
  return{nodes,adj,edges,entry,exit,children};
}
function topoDependencyGraph(graph){
  const degree=graph.nodes.map(()=>0),queue=[],order=[];
  for(const e of graph.edges)degree[e.to]++;
  for(const id of graph.nodes)if(!degree[id])queue.push(id);
  for(let i=0;i<queue.length;i++){const id=queue[i];order.push(id);for(const e of graph.adj[id])if(--degree[e.to]===0)queue.push(e.to)}
  return order.length===graph.nodes.length?order:null;
}
function dependencyCycle(tasks=proj.tasks,replacement=null){return topoDependencyGraph(buildDependencyGraph(tasks,replacement))===null}
function validateDependencies(id,deps){
  const target=byId(id);if(!target)return'任务已不存在，请重新打开编辑窗口';
  if(!Array.isArray(deps))return'依赖数据无效';
  if(target.type==='pipeline'&&deps.length)return'管线贯穿项目周期，不参与依赖';
  const seen=new Set();
  for(const dep of deps){
    if(dep===id)return'任务不能依赖自己';
    if(seen.has(dep))return'同一个前置任务不能重复添加';
    seen.add(dep);
    const before=byId(dep);if(!before)return'前置任务已不存在，请移除后再保存';
    if(before.type==='pipeline')return'管线贯穿项目周期，不参与依赖';
  }
  return dependencyCycle(proj.tasks,{id,deps})?'该依赖会形成循环（含父子任务约束），无法保存':null;
}
function analyze(){
  crit=new Set();cf=new Set();critEdges=new Set();
  // 日期冲突独立检查：即使只有节点，或依赖图异常，也不跳过；与界面采用同一汇总范围。
  for(const t of proj.tasks){
    if(t.type==='pipeline'||!t.deps||!t.deps.length)continue;
    const range=eRange(t);
    for(const id of t.deps){const before=byId(id);if(before&&before.type!=='pipeline'&&range.s<eRange(before).e){cf.add(t.id);break}}
  }
  const graph=buildDependencyGraph(),order=topoDependencyGraph(graph);
  if(!order){
    if(!dependencyCycleWarned)toast('检测到循环依赖，关键路径暂不计算；请移除循环中的依赖','warn',5000);
    dependencyCycleWarned=true;return;
  }
  dependencyCycleWarned=false;
  const earliest=graph.nodes.map(()=>0);
  for(const id of order)for(const e of graph.adj[id])earliest[e.to]=Math.max(earliest[e.to],earliest[id]+e.weight);
  const finish=earliest.reduce((max,time)=>Math.max(max,time),0),latest=graph.nodes.map(()=>finish);
  for(let i=order.length-1;i>=0;i--){const id=order[i];for(const e of graph.adj[id])latest[id]=Math.min(latest[id],latest[e.to]-e.weight)}
  for(const t of proj.tasks){
    if(t.type==='pipeline')continue;
    const start=graph.entry.get(t.id),end=graph.exit.get(t.id);
    if(earliest[start]===latest[start]&&earliest[end]===latest[end])crit.add(t.id);
  }
  for(const e of graph.edges)if(e.dep&&earliest[e.from]===latest[e.from]&&earliest[e.to]===latest[e.to]&&earliest[e.from]+e.weight===earliest[e.to])critEdges.add(dependencyKey(e.dep.from,e.dep.to));
}
