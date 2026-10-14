'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const geometry=require('../frontend/scripts/bar-geometry.js');
const source=fs.readFileSync(path.join(__dirname,'../frontend/scripts/export.js'),'utf8');

// Execute the real exporter with a recording canvas; the route helper is also
// real, so moving the drawing pass must not alter path, arrow or colour output.
function exportFixture({critical,inline}){
  const canvases=[],downloads=[],toasts=[];
  function canvas(){
    const events=[],states=[];let currentPath=[];
    const ctx={
      globalAlpha:1,lineWidth:1,dash:[],
      measureText:value=>({width:String(value).length*6}),
      scale(){},clip(){},drawImage(){},
      beginPath(){currentPath=[]},
      moveTo(...args){currentPath.push(['moveTo',...args])},
      lineTo(...args){currentPath.push(['lineTo',...args])},
      bezierCurveTo(...args){currentPath.push(['bezierCurveTo',...args])},
      arcTo(...args){currentPath.push(['arcTo',...args])},
      arc(...args){currentPath.push(['arc',...args])},
      rect(...args){currentPath.push(['rect',...args])},
      closePath(){currentPath.push(['closePath'])},
      setLineDash(values){this.dash=[...values]},
      stroke(){events.push({kind:'stroke',color:this.strokeStyle,width:this.lineWidth,dash:[...this.dash],path:currentPath.map(command=>[...command])})},
      fill(){events.push({kind:'fill',color:this.fillStyle,path:currentPath.map(command=>[...command])})},
      fillRect(x,y,w,h){events.push({kind:'fillRect',color:this.fillStyle,x,y,w,h})},
      fillText(text,x,y){events.push({kind:'text',text:String(text),color:this.fillStyle,x,y})},
      save(){states.push({globalAlpha:this.globalAlpha,lineWidth:this.lineWidth,fillStyle:this.fillStyle,strokeStyle:this.strokeStyle,dash:[...this.dash]})},
      restore(){Object.assign(this,states.pop())}
    };
    const result={width:0,height:0,events,getContext:()=>ctx,toBlob:callback=>callback({png:true})};
    canvases.push(result);return result;
  }
  const tasks=[
    {id:'FROM',name:'From',s:10,e:10,pct:0,type:'task',grp:'Role',deps:[]},
    {id:'TO',name:'To',s:inline?11:13,e:inline?11:14,pct:0,type:'task',grp:'Role',deps:['FROM']}
  ];
  const bPos=Object.fromEntries(tasks.map((task,index)=>[task.id,{
    ...geometry.span(task.s,task.e,8,22),type:'task',y:9+(inline?0:index*40),h:22,cy:20+(inline?0:index*40)
  }]));
  const sandbox={
    ScheduleBarGeometry:geometry,
    // PNG exports the schedule, without introducing any selection-only styling.
    ScheduleHighlights:new Proxy({},{get(){throw new Error('export must not read interactive highlight state')}}),
    document:{createElement:tag=>{assert.equal(tag,'canvas');return canvas()}},
    URL:{createObjectURL:()=> 'blob:dependency-layer-test',revokeObjectURL(){}},
    ce:()=>({click(){downloads.push(this.download)}}),setTimeout(){},
    toast:(...args)=>toasts.push(args),
    vRows:()=>tasks.map(t=>({t,depth:0})),byId:id=>tasks.find(t=>t.id===id),
    bPos,proj:{tasks,groups:[],flags:[]},bds:{mn:8},axis:{dw:22},zoom:'week',
    tD:Number,fD:String,fmtS:String,todayD:()=>100,isSum:()=>false,desc:()=>[],
    colW:()=>({name:120}),visibleTableColumns:()=>[{id:'name',name:'Name',width:120}],
    taskCellText:task=>task.name,phaseList:()=>[],filterQ:'',filterGrp:null,filterPhase:null,
    rowYs:[0,40],rowsHTotal:80,rowHOf:()=>40,RH:40,cf:new Set(),crit:new Set(),
    gc:()=> '#124875',barProgressCol:()=> '#345678',barTextCol:()=> '#fff',
    buildAxis:(minimum,maximum)=>({dw:22,tw:(maximum-minimum+1)*22,cells:[],groups:[]}),
    isCriticalDep:()=>critical
  };
  vm.createContext(sandbox);vm.runInContext(source+'\ncapPNG();',sandbox);
  assert.equal(downloads.length,1,JSON.stringify(toasts));
  assert.ok(toasts.some(([,kind])=>kind==='success'));
  return{events:canvases[0].events,route:geometry.connector(bPos.FROM,bPos.TO)};
}

for(const critical of [false,true])for(const inline of [false,true]){
  test(`PNG paints ${critical?'critical':'ordinary'} ${inline?'inline joints':'curves and arrows'} below task bars`,()=>{
    const{events,route}=exportFixture({critical,inline}),color=critical?'#f53f3f':'#86909c';
    const dependencyEvents=events.filter(event=>(event.kind==='stroke'||event.kind==='fill')&&event.color===color);
    const bars=events.filter(event=>event.kind==='fillRect'&&event.color==='#124875');
    assert.equal(bars.length,2,'both endpoint task bodies are painted');
    assert.equal(dependencyEvents.length,inline?1:2,'the existing inline/arrow drawing semantics remain intact');
    for(const dependency of dependencyEvents)for(const bar of bars){
      assert.ok(events.indexOf(dependency)<events.indexOf(bar),'every dependency stroke and arrow is below both task bodies');
    }
    const stroke=dependencyEvents[0];
    assert.equal(stroke.kind,'stroke');assert.equal(stroke.width,critical?2:1.3);
    assert.deepEqual(stroke.dash,inline?[]:critical?[7,3]:[5,5]);
    assert.deepEqual(stroke.path,route.commands.map(([name,...coords])=>[name,...coords.map((value,index)=>value+(index%2?52:120))]));
    if(!inline){
      assert.deepEqual(dependencyEvents[1].path,[...route.arrow.map(([x,y],index)=>[index?'lineTo':'moveTo',x+120,y+52]),['closePath']]);
    }
  });
}
