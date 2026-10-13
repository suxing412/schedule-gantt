/* Init */
/* The shared landing page is independent from all local/desktop project storage. */
let workspaceStarted=false;
function startWorkspace(){
  if(!proj)return false;
  const first=!workspaceStarted;
  if(first){
    zoom=(proj.meta&&proj.meta.defView)||'week';
    document.querySelectorAll('#zoom-seg .seg-btn').forEach(b=>{b.classList.toggle('active',b.dataset.z===zoom);b.setAttribute('aria-pressed',b.dataset.z===zoom?'true':'false')});
    bindUI();WorkspaceShell.bind();workspaceStarted=true;
  }
  render();ensureFill();snap();if(first)setTimeout(goToday,60);return true;
}
(async function(){
  if(typeof SharedWorkspaceUI!=='undefined')SharedWorkspaceUI.bind();
  await load();
  if(sharedEnabled()){if(proj&&SharedWorkspace.state().screen==='ready'&&!workspaceStarted)startWorkspace();return;}
  if(!proj&&!applyProject(sample()))throw new Error('示例数据初始化失败：'+lastProjectError);
  startWorkspace();
})();
