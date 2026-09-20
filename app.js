/* ============================================================
 * 极地航线决策推演系统 PolarRoute
 * 单文件纯前端：Canvas 海图 + 确定性环境模型 + 事件溯源推演
 * ============================================================ */
'use strict';

/* ---------------- 常量与世界设定 ---------------- */
const W = 1000, H = 720;                 // 海图逻辑坐标（1 单位 = 1 nmi）
const T0 = Date.UTC(2026, 10, 18, 8, 0); // 任务开始 2026-11-18 08:00Z
const HOUR = 3600e3;
const MAX_PLAN_H = 48;                    // 时间轴最大推演时长
const SPEED_DEFAULT = 12;
const SPEED_MIN = 4, SPEED_MAX = 18;
const FUEL_START = 100;
const UNIT_NMI = 0.25;                    // 1 海图单位 = 0.25 nmi（全图约 250 nmi）
const SAMPLE_STEP_NMI = 0.2;              // 航线采样步长 nmi

// 岸线（多边形）
const LANDS = [
  [[0,0],[300,0],[300,40],[250,80],[180,120],[110,140],[50,150],[0,180]],
  [[1000,0],[1000,240],[945,225],[895,190],[865,130],[885,60],[930,20]],
  [[740,720],[1000,720],[1000,545],[930,560],[860,600],[790,660]],
];
const PORT = { x: 70, y: 185, name: '出发港 · 长城锚地' };
const STATION = { x: 858, y: 590, name: '补给站 · 极地3号',
  winOpen: 16, winClose: 28, fuelOnArrival: 92 }; // 窗口为任务相对小时

// 高风险冰带（椭圆带，带漂移速度）
const ICE_BELTS = [
  { id:'B1', cx:500, cy:282, rx:170, ry:40, rot:0.28,
    dx:-0.45, dy:0.16, intensity:0.95, name:'B1 横贯冰带' },
  { id:'B2', cx:700, cy:488, rx:105, ry:36, rot:-0.5,
    dx:0.28, dy:-0.2, intensity:0.78, name:'B2 补给口冰带' },
];

// 通信覆盖圆（固定基站；之外即盲区）
const COMM = [
  { x:70, y:185, r:120 },
  { x:560, y:400, r:135 },
  { x:858, y:590, r:125 },
];

// 初始航路点（首尾锁定）
function defaultWaypoints() {
  return [
    { id:'wp0', x:PORT.x, y:PORT.y, locked:true, wait:0 },
    { id:'wp1', x:300, y:235, wait:0 },
    { id:'wp2', x:560, y:300, wait:0 },
    { id:'wp3', x:720, y:420, wait:0 },
    { id:'wp4', x:STATION.x, y:STATION.y, locked:true, wait:0 },
  ];
}

// 浮冰（确定性位置场：漂移 + 环流）
const FLOE_COUNT = 130;
const FLOES = [];
(function genFloes(){
  let seed = 20261118;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < FLOE_COUNT; i++) {
    const cluster = rnd();
    let bx, by, r, driftScale;
    if (cluster < 0.45) { bx = 420 + rnd()*180; by = 240 + rnd()*130; r = 3 + rnd()*7; driftScale = 1; }
    else if (cluster < 0.75) { bx = 620 + rnd()*200; by = 440 + rnd()*160; r = 3 + rnd()*8; driftScale = .8; }
    else { bx = 180 + rnd()*640; by = 180 + rnd()*420; r = 2 + rnd()*5; driftScale = .5; }
    FLOES.push({
      bx, by, r,
      vx: (-0.5 + rnd()*0.5) * driftScale,
      vy: (-0.3 + rnd()*0.4) * driftScale,
      swirl: 8 + rnd()*14,
      phase: rnd()*Math.PI*2,
      rot: rnd()*Math.PI*2,
      verts: (()=>{ const n=7+Math.floor(rnd()*4); return Array.from({length:n},()=>.72+rnd()*.4); })(),
    });
  }
})();

/* ---------------- 几何 / 工具 ---------------- */
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a,b,t)=>a+(b-a)*t;
function pointInPoly(p, poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>p.y)!=(yj>p.y))&&(p.x<(xj-xi)*(p.y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
const onLand = p => LANDS.some(l=>pointInPoly(p,l));
function segHit(p,a,b,tol=8){
  const abx=b.x-a.x, aby=b.y-a.y;
  const t=clamp(((p.x-a.x)*abx+(p.y-a.y)*aby)/(abx*abx+aby*aby||1),0,1);
  return { t, d: Math.hypot(p.x-(a.x+abx*t), p.y-(a.y+aby*t)) , dTol:tol};
}
let uid=0; const newId=p=>`${p}${++uid}_${Date.now().toString(36)}`;

/* ---------------- 确定性环境模型 ---------------- */
// 风：随时间缓慢旋转，风速起伏
function windAt(tMs){
  const h = (tMs-T0)/HOUR;
  const dir = (20 + h*14 + 12*Math.sin(h*.21)) % 360;          // 风向（吹来的方向，度）
  const speed = 16 + 9*Math.sin(h*.33+1) + 5*Math.sin(h*.9);   // 风速 kn
  return { dir, speed: Math.max(4,speed) };
}
// 雾团（缓慢漂移的径向团）
const FOG_BANKS = [
  { bx:520, by:380, r:150, dx:0.25, dy:0.12, phase:.3 },
  { bx:300, by:480, r:120, dx:0.18, dy:-0.1, phase:2.1 },
];
function visibilityAt(p, tMs){
  const h=(tMs-T0)/HOUR;
  let v = 9 + 3*Math.sin(h*.15+.5); // 全局 6~12 nmi
  for(const f of FOG_BANKS){
    const cx=f.bx+f.dx*h+22*Math.sin(h*.08+f.phase);
    const cy=f.by+f.dy*h+16*Math.cos(h*.1+f.phase);
    const d=Math.hypot(p.x-cx,p.y-cy);
    if(d<f.r) v=Math.min(v, 0.8 + 4.2*(d/f.r));
  }
  return clamp(v, .4, 12);
}
// 冰带在 t 时刻的中心
function beltCenter(b, tMs){
  const h=(tMs-T0)/HOUR;
  return { cx:b.cx+b.dx*h, cy:b.cy+b.dy*h };
}
// 点相对椭圆（考虑旋转）的归一化距离 <1 即带内
function beltNorm(p, b, tMs){
  const c=beltCenter(b,tMs);
  const co=Math.cos(b.rot), si=Math.sin(b.rot);
  const dx=p.x-c.cx, dy=p.y-c.cy;
  const rx=dx*co+dy*si, ry=-dx*si+dy*co;
  return Math.hypot(rx/b.rx, ry/b.ry);
}
function floeAt(i, tMs){
  const f=FLOES[i], h=(tMs-T0)/HOUR;
  return {
    x: f.bx + f.vx*h + f.swirl*Math.sin(h*.5+f.phase),
    y: f.by + f.vy*h + f.swirl*.7*Math.cos(h*.42+f.phase),
    r: f.r, verts: f.verts, rot: f.rot+h*.05,
  };
}
// 冰况风险 0~1：冰带贡献 + 浮冰密度贡献
// 浮冰空间哈希：按 30 分钟时间片缓存（该尺度内浮冰仍在同一格附近），避免每次查询遍历全部浮冰
const FLOE_CELL=50;
let floeGrid=null, floeGridBucket=-1;
let floePosCache=null;
function floeIndex(tMs){
  const bucket=Math.floor(((tMs-T0)/HOUR)/0.5);
  if(floeGrid&&bucket===floeGridBucket) return floeGrid;
  floePosCache=new Array(FLOES.length);
  for(let i=0;i<FLOES.length;i++) floePosCache[i]=floeAt(i,tMs);
  floeGrid=new Map();
  for(let i=0;i<FLOES.length;i++){
    const fl=floePosCache[i];
    const cx=Math.floor(fl.x/FLOE_CELL), cy=Math.floor(fl.y/FLOE_CELL);
    for(let gx=cx-1;gx<=cx+1;gx++)for(let gy=cy-1;gy<=cy+1;gy++){
      const key=gx*10000+gy;
      let arr=floeGrid.get(key); if(!arr) floeGrid.set(key,arr=[]);
      arr.push(i);
    }
  }
  floeGridBucket=bucket;
  return floeGrid;
}
function iceAt(p, tMs){
  let risk=0, beltHit=null, beltRisk=0;
  for(const b of ICE_BELTS){
    const n=beltNorm(p,b,tMs);
    if(n<1.4){
      const k=Math.max(0,1-n/1.4)*b.intensity;
      if(n<1 && k>beltRisk){ beltRisk=k; beltHit=b; }
      if(k>risk) risk=k;
    }
  }
  let local=0;
  const grid=floeIndex(tMs);
  const arr=grid.get(Math.floor(p.x/FLOE_CELL)*10000+Math.floor(p.y/FLOE_CELL));
  if(arr){
    for(const i of arr){
      const fl=floePosCache[i];
      const d=Math.hypot(fl.x-p.x,fl.y-p.y);
      if(d<fl.r+5) local += (1-d/(fl.r+5))*.22;
    }
  }
  risk=Math.max(risk, Math.min(.32,local));
  return { risk:clamp(risk,0,1), belt:beltHit };
}
function inComm(p){
  return COMM.some(c=>Math.hypot(p.x-c.x,p.y-c.y)<=c.r);
}

/* ---------------- 航路 / 计划推演 ---------------- */
// 把航路点展开为折线采样点（含累积航程）
function buildPath(waypoints){
  const pts=[];
  let cum=0;
  pts.push({x:waypoints[0].x,y:waypoints[0].y,s:0});
  for(let i=0;i<waypoints.length-1;i++){
    const a=waypoints[i],b=waypoints[i+1];
    const segLen=dist(a,b)*UNIT_NMI;
    const steps=Math.max(1,Math.round(segLen/SAMPLE_STEP_NMI));
    for(let k=1;k<=steps;k++){
      const tt=k/steps;
      const s=cum+segLen*tt;
      pts.push({x:lerp(a.x,b.x,tt),y:lerp(a.y,b.y,tt),s});
    }
    cum+=segLen;
  }
  return { pts, total:cum, segBreaks: (()=>{
    const br=[]; let c2=0;
    for(let i=0;i<waypoints.length-1;i++){ c2+=dist(waypoints[i],waypoints[i+1])*UNIT_NMI; br.push(c2); }
    return br;
  })() };
}

// 有效航速（冰况/能见度减速）
function effectiveSpeed(planSpeed, ice, vis){
  let v=planSpeed;
  v*= (1 - 0.62*ice.risk);                 // 冰况降速
  if(vis<2) v*= (0.45+0.275*vis);          // 低能见度降速
  return Math.max(2, v); // 冰中最低维持航速约 2 kn
}
// 单位海里油耗（%/nmi），冰况 + 低能见度增加
function burnRate(planSpeed, ice, vis){
  const iceMul=1+0.8*ice.risk;
  const visMul=vis<2?1.25:1;
  return (0.012*planSpeed+0.075)*iceMul*visMul;  // 约 0.22%/nmi @12kn，全程清水约 50%
}

/*
 * 沿路径做时间推演：从 tStart、路径距离 s0 开始，
 * 返回每段（航段）的时间区间、全程事件、预计抵达等。
 * opts: { startFuel, waitingAt:{wpIndex:hours} }
 */
function simulate(waypoints, path, tStart, s0, startFuel, speedGlobal){
  const { pts, segBreaks } = path;
  // 找到 s0 对应的采样索引
  let idx=0;
  while(idx<pts.length-1 && pts[idx+1].s<s0) idx++;

  let segIdx=0;
  while(segIdx<segBreaks.length && segBreaks[segIdx]<=s0+1e-6) segIdx++;

  let t=tStart, fuel=startFuel, s=s0;
  const events=[];      // 关键事件
  const segData=[];
  const trace=[];       // 全程积分样本 {t,s}
  trace.push({t,s});
  // 起始航路点（船所在航段的起点）上已设置的等待，计划阶段不再重复计入
  for(let si=segIdx; si<segBreaks.length; si++){
    // 航段计划航速：取该航段终点航点的 customSpeed
    const planSpeed = waypoints[si+1].customSpeed!=null ? waypoints[si+1].customSpeed : speedGlobal;
    const endS=segBreaks[si];
    const segStartT=t;
    let iceMax=0, iceSum=0, iceN=0, visMin=99, commOutside=0, len=0;
    let j=idx;
    for(; j<pts.length-1 && pts[j].s<endS; j++){
      const p=pts[j], p2=pts[j+1];
      const ds=p2.s-p.s;
      const ice=iceAt(p,t), vis=visibilityAt(p,t);
      const v=effectiveSpeed(planSpeed,ice,vis);
      const dt=ds/v;                        // 小时
      t+=dt*HOUR; fuel-=burnRate(planSpeed,ice,vis)*ds;
      iceMax=Math.max(iceMax,ice.risk); iceSum+=ice.risk; iceN++;
      visMin=Math.min(visMin,vis);
      if(!inComm(p)) commOutside+=ds;
      len+=ds;
      if(!trace.length||t-trace[trace.length-1].t>=0.25*HOUR-1)
        trace.push({t,s:p2.s});
    }
    idx=j;
    segData.push({
      seg:si, enterT:segStartT, exitT:t, len,
      iceMax, iceAvg:iceSum/Math.max(1,iceN), visMin,
      commOutside, distOutside:commOutside,
    });
    s=endS;
    // 航路点等待窗口（终点除外）
    const wp=waypoints[si+1];
    if(wp && wp.wait>0 && si<waypoints.length-2){
      const waitMs=wp.wait*HOUR;
      events.push({type:'wait', t, wp:si+1, hours:wp.wait,
        comm:inComm(wp)});
      t+=waitMs;
      trace.push({t,s});
    }
  }
  const stationT=t;   // 到达补给点（即最后航路点）
  // 补给窗口判定
  const arriveH=(stationT-T0)/HOUR;
  let stationOk=true, stationNote='';
  if(arriveH<STATION.winOpen){ stationOk=false; stationNote='early'; }
  if(arriveH>STATION.winClose){ stationOk=false; stationNote='late'; }
  fuel=clamp(fuel,0,100);
  return {
    segData, events, stationT, arriveH, stationOk, stationNote,
    fuelAtStation:fuel, endT:stationT, totalH:(stationT-tStart)/HOUR,
    depleted:fuel<=0, trace,
  };
}

/* ---------------- 全局状态 ---------------- */
const state = {
  waypoints: defaultWaypoints(),
  speed: SPEED_DEFAULT,
  t: T0,                 // 当前模拟时间
  playing: false,
  rate: 300,             // 模拟分钟 / 真实秒
  s: 0,                  // 船舶沿当前路径累积航程
  fuel: FUEL_START,
  waitingUntil: 0,       // >t 时原地等待
  path: null,
  plan: null,
  track: [],             // 历史尾迹 [{x,y,t}]
  selectedSeg: null,     // 选中航段索引
  online: true,
  pendingOps: [],        // 离线期间操作 {id,label,reapply,validate,detail,status}
  offlineBase: null,      // 进入盲区时的真实航路基线
  history: [],           // 历史节点
  currentNode: null,
  branchSeq: 0,
  branchColor: '#4fd1e8',
  refueled: false,
  arrived: false,
  dragging: null,
  modalWp: null,
};

function recompute(){
  state._planT=0; state._planS=-1;
  state.path=buildPath(state.waypoints);
  state.plan=simulate(state.waypoints,state.path,state.t,state.s,state.fuel,state.speed);
  renderChain();
  renderTimeline();
  renderGauges();
}

/* ---------------- 历史节点 / 分支推演 ---------------- */
function snapshot(label, type){
  const node={
    id:newId('n'),
    t:state.t, s:state.s, fuel:state.fuel,
    waypoints:JSON.parse(JSON.stringify(state.waypoints)),
    speed:state.speed,
    waitingUntil:state.waitingUntil,
    track:state.track.slice(-400),
    label, type,
    parent:state.currentNode?state.currentNode.id:null,
    branch:state.currentNode?state.currentNode.branch:'主线',
    color:state.currentNode?state.currentNode.color:state.branchColor,
    seq:state.history.length,
    refueled:state.refueled,
    planSummary: summarizePlan(),
  };
  state.history.push(node);
  if(state.history.length>120) state.history.shift();
  state.currentNode=node;
  renderHistory();
}
function summarizePlan(){
  const p=state.plan;
  if(!p) return null;
  return {
    arriveH:p.arriveH, stationOk:p.stationOk, fuelAtStation:p.fuelAtStation,
    maxIce:Math.max(0,...p.segData.map(d=>d.iceMax)),
  };
}
function restoreNode(node){
  state.t=node.t; state.s=node.s; state.fuel=node.fuel;
  state.waypoints=JSON.parse(JSON.stringify(node.waypoints));
  state.speed=node.speed;
  state.waitingUntil=node.waitingUntil;
  state.track=node.track.slice();
  state.refueled=node.refueled;
  state.arrived=false;
  state.currentNode=node;
  state.branchColor=node.color;
  state.playing=false;
  updatePlayBtn();
  // 恢复点之后的离线操作全部作废（属于另一分支）
  state.pendingOps=state.pendingOps.filter(o=>o.baseT<=node.t);
  recompute();
  flashTimeline('已从历史节点重新推演（后续历史已归档为平行分支）');
  renderHistory();
  renderOps();
}
function branchFork(label){
  state.branchSeq++;
  const palette=['#a78bfa','#f5b94a','#4ade80','#f2635e','#4fd1e8','#f472b6'];
  state.branchColor=palette[state.branchSeq%palette.length];
  const name=`分支 ${String.fromCharCode(64+state.branchSeq)}`;
  snapshot(`${label} · 开启${name}`, 'fork');
  state.currentNode.branch=name;
  state.currentNode.color=state.branchColor;
  renderHistory();
}

/* ---------------- 离线操作队列 ---------------- */
function queueOp(op){
  op.id=newId('op');
  op.baseT=state.t;
  op.baseNode=state.currentNode?state.currentNode.id:null;
  op.status='pending';
  state.pendingOps.push(op);
  renderOps();
  toast(`离线队列：${op.label}（将在通信恢复后校验合并）`);
}
// 通信恢复：以恢复时刻的航路状态为基线，逐项重放离线操作并校验
function mergeOfflineOps(){
  if(!state.pendingOps.length) return;
  // 丢弃离线期间在画面上临时应用的草稿，恢复到真实（基线）航路
  const shipPos=posAt(state.s);
  if(state.offlineBase){
    state.waypoints=state.offlineBase.waypoints;
    state.speed=state.offlineBase.speed;
  }
  recompute();
  const accepted=[], rejected=[];
  for(const op of state.pendingOps){
    const saved=JSON.parse(JSON.stringify({waypoints:state.waypoints,speed:state.speed}));
    op.reapply();
    const res=op.validate?op.validate():true;
    if(res===true){ op.status='ok'; accepted.push(op); }
    else {
      op.status='rej'; op.rejectReason=res;
      rejected.push(op);
      state.waypoints=saved.waypoints; state.speed=saved.speed;
    }
  }
  state.offlineBase=null;
  rebaseShip(shipPos);
  recompute();
  renderOps();
  showMergeReport(accepted,rejected);
  state.pendingOps=[];
}
function showMergeReport(acc,rej){
  if(!acc.length&&!rej.length) return;
  let msg='<div class="chain-card sev-low"><h4>📡 通信恢复 · 离线操作合并报告</h4>';
  if(acc.length) msg+=`<p style="color:var(--teal)">已合并 ${acc.length} 项有效操作：${acc.map(o=>o.label).join('、')}</p>`;
  if(rej.length) msg+=rej.map(o=>`<p style="color:var(--red)">已拒绝：${o.label} — ${o.rejectReason}</p>`).join('');
  msg+='</div>';
  document.getElementById('tabChain').insertAdjacentHTML('afterbegin',msg);
}

/* ---------------- Canvas 渲染 ---------------- */
const canvas=document.getElementById('chart');
const ctx=canvas.getContext('2d');
let view={scale:1,ox:0,oy:0,dpr:1,cssW:1,cssH:1};
function resize(){
  const wrap=document.getElementById('chartWrap');
  const cw=wrap.clientWidth, chh=wrap.clientHeight;
  view.dpr=window.devicePixelRatio||1;
  canvas.width=cw*view.dpr; canvas.height=chh*view.dpr;
  canvas.style.width=cw+'px'; canvas.style.height=chh+'px';
  view.scale=Math.min(cw/(W+80), chh/(H+80));
  view.ox=(cw-W*view.scale)/2; view.oy=(chh-H*view.scale)/2;
  view.cssW=cw; view.cssH=chh;
}
window.addEventListener('resize',()=>{resize();});
const toScreen=p=>({x:view.ox+p.x*view.scale,y:view.oy+p.y*view.scale});
const toWorld=(sx,sy)=>(({x:(sx-view.ox)/view.scale,y:(sy-view.oy)/view.scale}));

function draw(){
  ctx.setTransform(view.dpr,0,0,view.dpr,0,0);
  ctx.clearRect(0,0,view.cssW,view.cssH);
  // 世界范围裁剪
  const tl=toScreen({x:0,y:0}), br=toScreen({x:W,y:H});
  ctx.save();
  ctx.beginPath();ctx.rect(tl.x,tl.y,br.x-tl.x,br.y-tl.y);ctx.clip();
  drawSea();
  drawCommZones();
  drawIceBelts();
  drawFog();
  drawFloes();
  drawLands();
  drawPorts();
  drawRoute();
  drawWaypoints();
  drawShip();
  drawWindStreaks();
  ctx.restore();
  drawMapFrame();
  drawCompass();
}
function drawMapFrame(){
  const tl=toScreen({x:0,y:0}), br=toScreen({x:W,y:H});
  ctx.strokeStyle='rgba(79,209,232,.25)';ctx.lineWidth=1;
  ctx.strokeRect(tl.x,tl.y,br.x-tl.x,br.y-tl.y);
  const pxPerNmi=view.scale*UNIT_NMI;
  const lenPx=20*pxPerNmi;
  const sc=document.getElementById('mapScale');
  sc.style.width=lenPx+'px';
  sc.textContent='20 nmi';
}

function drawSea(){
  const g=ctx.createLinearGradient(0,0,0,view.cssH);
  g.addColorStop(0,'#0b1d2e'); g.addColorStop(1,'#08141f');
  ctx.fillStyle=g; ctx.fillRect(0,0,view.cssW,view.cssH);
  // 经纬网格 10 nmi
  ctx.strokeStyle='rgba(120,170,200,.07)'; ctx.lineWidth=1;
  ctx.fillStyle='rgba(125,149,171,.55)'; ctx.font='9px monospace';
  for(let x=0;x<=W;x+=50){
    const a=toScreen({x,y:0}),b=toScreen({x,y:H});
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    if(x%100===0) ctx.fillText(`${x}E`,a.x+3,a.y-4);
  }
  for(let y=0;y<=H;y+=50){
    const a=toScreen({x:0,y}),b=toScreen({x:W,y});
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    if(y%100===0) ctx.fillText(`${y}N`,a.x+3,a.y+11);
  }
}

function poly(pts){
  ctx.beginPath();
  pts.forEach((p,i)=>{const s=toScreen({x:p[0],y:p[1]});i?ctx.lineTo(s.x,s.y):ctx.moveTo(s.x,s.y);});
  ctx.closePath();
}
function drawLands(){
  for(const l of LANDS){
    poly(l);
    const g=ctx.createLinearGradient(0,0,0,view.cssH);
    g.addColorStop(0,'#e8f2f7');g.addColorStop(1,'#b9d2df');
    ctx.fillStyle=g;ctx.fill();
    ctx.strokeStyle='#8fb2c6';ctx.lineWidth=1.5;ctx.stroke();
  }
}

function drawCommZones(){
  for(const c of COMM){
    const s=toScreen(c), r=c.r*view.scale;
    ctx.beginPath();ctx.arc(s.x,s.y,r,0,7);
    ctx.fillStyle='rgba(79,209,232,.07)';ctx.fill();
    ctx.setLineDash([6,5]);ctx.strokeStyle='rgba(79,209,232,.5)';
    ctx.lineWidth=1.2;ctx.stroke();ctx.setLineDash([]);
  }
}

function beltOffscreen(){
  const S=256, cv=document.createElement('canvas');
  cv.width=S;cv.height=S;
  const oc=cv.getContext('2d');
  oc.translate(S/2,S/2);
  // 在“单位圆=椭圆”的归一化空间内绘制
  oc.scale(S/2,S/2);
  oc.beginPath();oc.arc(0,0,1,0,Math.PI*2);oc.clip();
  const g=oc.createRadialGradient(0,0,0,0,0,1);
  g.addColorStop(0,'rgba(242,80,74,.6)');
  g.addColorStop(.55,'rgba(242,120,70,.34)');
  g.addColorStop(1,'rgba(242,120,70,0)');
  oc.fillStyle=g;
  oc.beginPath();oc.arc(0,0,1,0,Math.PI*2);oc.fill();
  return cv;
}
function drawEllipseBelt(b){
  const c=beltCenter(b,state.t);
  const s=toScreen({x:c.cx,y:c.cy});
  const rx=b.rx*view.scale, ry=b.ry*view.scale;
  const off=b._off||(b._off=beltOffscreen());
  ctx.save();
  ctx.translate(s.x,s.y);ctx.rotate(b.rot);
  ctx.drawImage(off,-rx,-ry,rx*2,ry*2);
  ctx.beginPath();ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2);
  ctx.strokeStyle=`rgba(255,120,110,${.85*b.intensity})`;
  ctx.lineWidth=1.5;ctx.setLineDash([8,6]);ctx.stroke();ctx.setLineDash([]);
  ctx.restore();
  ctx.fillStyle='rgba(255,180,170,.9)';ctx.font='10px sans-serif';
  ctx.fillText('高风险 '+b.id,s.x-28,s.y-ry-6);
}
function drawIceBelts(){ ICE_BELTS.forEach(drawEllipseBelt); }

function drawFloes(){
  for(let i=0;i<FLOES.length;i+=1){
    const fl=floeAt(i,state.t), s=toScreen(fl);
    if(s.x<-20||s.x>view.cssW+20||s.y<-20||s.y>view.cssH+20) continue;
    ctx.save();ctx.translate(s.x,s.y);ctx.rotate(fl.rot);
    ctx.beginPath();
    const n=fl.verts.length, rr=fl.r*view.scale;
    fl.verts.forEach((v,k)=>{
      const a=k/n*Math.PI*2;
      const x=Math.cos(a)*rr*v, y=Math.sin(a)*rr*v*.72;
      k?ctx.lineTo(x,y):ctx.moveTo(x,y);
    });
    ctx.closePath();
    ctx.fillStyle='rgba(200,228,240,.8)';ctx.fill();
    ctx.strokeStyle='rgba(140,180,200,.6)';ctx.lineWidth=.8;ctx.stroke();
    ctx.restore();
  }
}

function drawFog(){
  for(const f of FOG_BANKS){
    const h=state.t/HOUR;
    const cx=f.bx+f.dx*h+22*Math.sin(h*.08+f.phase);
    const cy=f.by+f.dy*h+16*Math.cos(h*.1+f.phase);
    const s=toScreen({x:cx,y:cy}), r=f.r*view.scale;
    const g=ctx.createRadialGradient(s.x,s.y,r*.1,s.x,s.y,r);
    g.addColorStop(0,'rgba(210,220,230,.32)');g.addColorStop(1,'rgba(210,220,230,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(s.x,s.y,r,0,7);ctx.fill();
  }
}

function drawPorts(){
  const mark=(p,color,label)=>{
    const s=toScreen(p);
    ctx.beginPath();ctx.arc(s.x,s.y,7,0,7);
    ctx.fillStyle=color;ctx.fill();
    ctx.strokeStyle='#0a1520';ctx.lineWidth=2;ctx.stroke();
    ctx.fillStyle='#dce9f5';ctx.font='11px sans-serif';
    ctx.fillText(label,s.x+11,s.y-9);
  };
  mark(PORT,'#4fd1e8',PORT.name);
  mark(STATION,'#f5b94a',STATION.name);
  // 补给窗口
  const s=toScreen(STATION);
  ctx.fillStyle='rgba(245,185,74,.85)';ctx.font='9px sans-serif';
  ctx.fillText(`窗口 T+${fmt(STATION.winOpen*HOUR)} ~ T+${fmt(STATION.winClose*HOUR)}`,s.x+11,s.y+6);
}

function drawRoute(){
  const wps=state.waypoints;
  // 航段
  for(let i=0;i<wps.length-1;i++){
    const a=toScreen(wps[i]),b=toScreen(wps[i+1]);
    const sel=state.selectedSeg===i;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
    ctx.strokeStyle=sel?'#f5b94a':'rgba(79,209,232,.75)';
    ctx.lineWidth=sel?3.5:2.4;
    ctx.setLineDash(sel?[]:[9,6]);ctx.stroke();ctx.setLineDash([]);
    // 标签
    const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2-8};
    ctx.fillStyle=sel?'#f5b94a':'rgba(125,149,171,.9)';
    ctx.font='10px sans-serif';
    ctx.fillText(`航段 ${i+1}`,mid.x-14,mid.y);
  }
  // 尾迹
  if(state.track.length>1){
    ctx.beginPath();
    state.track.forEach((p,i)=>{const s=toScreen(p);i?ctx.lineTo(s.x,s.y):ctx.moveTo(s.x,s.y);});
    ctx.strokeStyle='rgba(74,222,128,.55)';ctx.lineWidth=2;ctx.stroke();
  }
}

function drawWaypoints(){
  state.waypoints.forEach((w,i)=>{
    if(w.locked) return;
    const s=toScreen(w);
    const hover=state.dragging===w;
    ctx.beginPath();
    ctx.rect(s.x-7,s.y-7,14,14);
    ctx.fillStyle=hover?'#f5b94a':'#132436';
    ctx.fill();
    ctx.strokeStyle=hover?'#fff':'#4fd1e8';ctx.lineWidth=2;ctx.stroke();
    ctx.fillStyle='#dce9f5';ctx.font='9px monospace';ctx.textAlign='center';
    ctx.fillText(String(i),s.x,s.y-11);
    ctx.textAlign='left';
    if(w.wait>0){
      ctx.fillStyle='#a78bfa';ctx.beginPath();ctx.arc(s.x+8,s.y-8,4,0,7);ctx.fill();
    }
  });
}

function drawShip(){
  const p=posAt(state.s);
  const s=toScreen(p);
  const next=posAt(Math.min(state.path.total,state.s+.5));
  const ang=Math.atan2(next.y-p.y,next.x-p.x);
  ctx.save();ctx.translate(s.x,s.y);ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(11,0);ctx.lineTo(-8,-6);ctx.lineTo(-5,0);ctx.lineTo(-8,6);ctx.closePath();
  ctx.fillStyle=state.arrived?'#4ade80':'#4fd1e8';
  ctx.shadowColor='#4fd1e8';ctx.shadowBlur=12;ctx.fill();
  ctx.shadowBlur=0;ctx.strokeStyle='#04222c';ctx.lineWidth=1;ctx.stroke();
  ctx.restore();
  // 通信状态环
  ctx.beginPath();ctx.arc(s.x,s.y,15,0,7);
  ctx.strokeStyle=state.online?'rgba(74,222,128,.7)':'rgba(242,99,94,.8)';
  ctx.setLineDash([3,3]);ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);
}

function drawWindStreaks(){
  const w=windAt(state.t);
  const rad=(w.dir+180)*Math.PI/180; // 风吹向
  const u=Math.cos(rad),v=Math.sin(rad);
  ctx.strokeStyle='rgba(180,210,230,.35)';ctx.lineWidth=1;
  for(let i=0;i<26;i++){
    const gx=((i*137.5)%W), gy=((i*263.7)%H);
    const len=8+w.speed*.5;
    const s=toScreen({x:gx,y:gy});
    ctx.beginPath();
    ctx.moveTo(s.x,s.y);
    ctx.lineTo(s.x+u*len,s.y+v*len);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x+u*len,s.y+v*len);
    ctx.lineTo(s.x+u*(len-4)-v*2.5,s.y+v*(len-4)+u*2.5);
    ctx.moveTo(s.x+u*len,s.y+v*len);
    ctx.lineTo(s.x+u*(len-4)+v*2.5,s.y+v*(len-4)-u*2.5);
    ctx.stroke();
  }
}

function drawCompass(){
  const x=view.cssW-46,y=42;
  ctx.beginPath();ctx.arc(x,y,20,0,7);
  ctx.fillStyle='rgba(10,20,31,.8)';ctx.fill();
  ctx.strokeStyle='#27506e';ctx.stroke();
  ctx.fillStyle='#7d95ab';ctx.font='9px sans-serif';ctx.textAlign='center';
  ctx.fillText('N',x,y-9);ctx.fillText('S',x,y+14);
  ctx.fillText('W',x-11,y+3);ctx.fillText('E',x+11,y+3);
  const w=windAt(state.t);
  const a=(w.dir-90)*Math.PI/180;
  ctx.beginPath();ctx.moveTo(x,y);
  ctx.lineTo(x+Math.cos(a)*14,y+Math.sin(a)*14);
  ctx.strokeStyle='#f5b94a';ctx.lineWidth=2;ctx.stroke();
  ctx.textAlign='left';
}

// 当前路径上距离 s 处的世界坐标
function posAt(s){
  const pts=state.path.pts;
  if(s<=0) return {x:pts[0].x,y:pts[0].y};
  if(s>=state.path.total) {const p=pts[pts.length-1];return {x:p.x,y:p.y};}
  let lo=0,hi=pts.length-1;
  while(lo<hi){const m=(lo+hi)>>1; pts[m].s<s?lo=m+1:hi=m;}
  const b=pts[lo],a=pts[lo-1]||b;
  const t=(s-a.s)/((b.s-a.s)||1);
  return {x:lerp(a.x,b.x,t),y:lerp(a.y,b.y,t)};
}
// 当前船所在航段索引
function currentSegIndex(){
  const br=state.path.segBreaks;
  for(let i=0;i<br.length;i++) if(state.s<br[i]-1e-6) return i;
  return br.length-1;
}
// 在路径距离 s 处应使用的计划航速
function planSpeedAt(s){
  const br=state.path.segBreaks;
  for(let i=0;i<br.length;i++){
    if(s<br[i]-1e-6){
      const w=state.waypoints[i+1];
      return w&&w.customSpeed!=null?w.customSpeed:state.speed;
    }
  }
  return state.speed;
}

/* ---------------- 时间推进 / 模拟步进 ---------------- */
let lastFrame=performance.now();
function frame(now){
  const dtReal=(now-lastFrame)/1000; lastFrame=now;
  if(state.playing && !state.arrived){
    const dtSimMin=state.rate*dtReal;
    advance(dtSimMin/60); // 模拟小时
  }
  draw();
  requestAnimationFrame(frame);
}

function advance(hours){
  let remain=hours;
  let n=0;
  while(remain>1e-6 && n++<400){
    const p=posAt(state.s);
    const wasOnline=state.online;
    state.online=inComm(p);
    if(wasOnline!==state.online){
      if(state.online){
        mergeOfflineOps();
        snapshot('通信恢复 · 离线操作已合并','comm');
      } else {
        state.offlineBase={
          waypoints:JSON.parse(JSON.stringify(state.waypoints)),
          speed:state.speed, s:state.s, t:state.t,
        };
        snapshot('进入通信盲区','comm');
      }
      updateCommUI();
    }
    // 等待窗口
    if(state.t<state.waitingUntil){
      const wh=Math.min(remain,(state.waitingUntil-state.t)/HOUR);
      state.t+=wh*HOUR; remain-=wh;
      if(state.t>=state.waitingUntil){ state.waitingUntil=0; }
      continue;
    }
    // 当前航段的计划航速
    const segIdxNow=currentSegIndex();
    const targetWp=state.waypoints[segIdxNow+1];
    const planSpeed=targetWp&&targetWp.customSpeed!=null?targetWp.customSpeed:state.speed;
    const ice=iceAt(p,state.t);
    const vis=visibilityAt(p,state.t);
    const v=effectiveSpeed(planSpeed,ice,vis);
    const total=state.path.total;
    // 本时间步内能航行的距离
    let ds=v*remain;
    let stepH=remain;
    // 若本航段终点带等待，且本步会越过它：先只走到该航路点
    let waitHere=false;
    const wpS=state.path.segBreaks[segIdxNow];
    if(targetWp&&targetWp.wait>0&&segIdxNow<state.waypoints.length-2
       && state.s+ds>=wpS){
      ds=wpS-state.s; stepH=ds/v; waitHere=true;
    }
    if(state.s+ds>=total){
      // 抵达终点（补给站）
      const dh=(total-state.s)/v;
      state.t+=dh*HOUR; state.fuel-=burnRate(planSpeed,ice,vis)*(total-state.s);
      state.s=total;
      onArrival();
      break;
    }
    state.fuel-=burnRate(planSpeed,ice,vis)*ds;
    state.s+=ds;
    state.t+=stepH*HOUR;
    remain-=stepH;
    state.fuel=Math.max(0,state.fuel);
    // 尾迹
    const np=posAt(state.s);
    const last=state.track[state.track.length-1];
    if(!last||dist(last,np)>2) state.track.push({x:np.x,y:np.y,t:state.t});
    // 燃料耗尽
    if(state.fuel<=0){
      state.playing=false; updatePlayBtn();
      flashTimeline('⛽ 燃料耗尽，任务中断');
      break;
    }
    // 抵达带等待窗口的航路点：转入等待
    if(waitHere){
      state.waitingUntil=state.t+targetWp.wait*HOUR;
      snapshot(`WP${segIdxNow+1} 等待 ${targetWp.wait}h`,'wait');
      targetWp.wait=0; // 已消费，避免重复
      continue;
    }
    if(stepH<=0) break;
  }
  updateClock();
  renderGauges();
  renderTimelineCursor();
  // 周期性历史节点（每跨 2 小时）
  const hb=Math.floor((state.t-T0)/HOUR/2);
  if(hb!==state._lastBucket && state.s>0){
    state._lastBucket=hb;
    snapshot(`T+${fmt((state.t-T0))} 例行节点`,'auto');
  }
  if(state.arrived) return;
  // 计划刷新：冰带持续漂移，按模拟时间每 10 分钟或位置显著变化时重算
  const move=Math.abs(state.s-(state._planS??-1));
  if(!state._planT || state.t-state._planT>10*60000 || move>2){
    state.plan=simulate(state.waypoints,state.path,state.t,state.s,state.fuel,state.speed);
    state._planT=state.t; state._planS=state.s;
    renderChain();
    renderTimeline();
    if(state.selectedSeg!=null) renderSegment(state.selectedSeg);
  }
}

function onArrival(){
  state.arrived=true; state.playing=false; updatePlayBtn();
  const arriveH=(state.t-T0)/HOUR;
  const ok=arriveH<=STATION.winClose && arriveH>=STATION.winOpen;
  snapshot(ok?'抵达补给站（窗口内）':'抵达补给站（错过窗口）','arrive');
  if(ok){
    state.fuel=Math.max(state.fuel,STATION.fuelOnArrival);
    state.refueled=true;
    flashTimeline(`✅ 抵达 ${STATION.name}，窗口内补给完成，燃料补至 ${STATION.fuelOnArrival}%`);
  }else{
    const why=arriveH<STATION.winOpen?'早于窗口开启':'晚于窗口关闭';
    flashTimeline(`⛔ 抵达 ${STATION.name}，但${why}，无法补给！`);
  }
  renderGauges();
}

/* ---------------- 仪表 / 时钟 ---------------- */
function fmt(ms){
  const h=Math.floor(ms/HOUR), m=Math.floor((ms%HOUR)/60000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function fmtClock(t){
  const d=new Date(t);
  const p=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}
function updateClock(){
  document.getElementById('clock').textContent=fmtClock(state.t);
  document.getElementById('clockSub').textContent=`任务 T+${fmt(state.t-T0)}`;
}
function riskLabel(r){
  if(r<.25) return {t:'低风险',cls:'risk-low',color:'var(--teal)'};
  if(r<.5) return {t:'中等风险',cls:'risk-mid',color:'var(--amber)'};
  if(r<.75) return {t:'高风险',cls:'risk-high',color:'var(--red)'};
  return {t:'极危险',cls:'risk-crit',color:'#b91c1c'};
}
function renderGauges(){
  const p=posAt(state.s);
  const next=posAt(Math.min(state.path.total,state.s+.5));
  let heading=(Math.atan2(next.y-p.y,next.x-p.x)*180/Math.PI+90+360)%360;
  const ice=iceAt(p,state.t), vis=visibilityAt(p,state.t), w=windAt(state.t);
  const waiting=state.t<state.waitingUntil;
  const v=waiting?0:effectiveSpeed(state.speed,ice,vis);
  set('gSpeed',v.toFixed(1)+' kn'+(waiting?'（等待）':''));
  set('gHeading',Math.round(heading)+'°');
  set('gDist',`${state.s.toFixed(0)} / ${state.path.total.toFixed(0)} nmi`);
  const fb=document.getElementById('fuelBar');
  fb.style.width=state.fuel+'%';
  fb.className='bar-fill fuel'+(state.fuel<20?' danger':state.fuel<40?' warn':'');
  set('gFuel',state.fuel.toFixed(1)+'%');
  set('gFuelAtStation',state.plan?clamp(state.plan.fuelAtStation,0,100).toFixed(1)+'%':'--');
  const dirs=['北','东北','东','东南','南','西南','西','西北'];
  set('gWind',`${dirs[Math.round(w.dir/45)%8]}风 ${w.dir.toFixed(0)}° / ${w.speed.toFixed(0)} kn`);
  set('gVis',vis.toFixed(1)+' nmi');
  const rl=riskLabel(ice.risk);
  const gIce=document.getElementById('gIce');
  gIce.textContent=rl.t+(ice.belt?`（${ice.belt.id}）`:'');
  gIce.style.color=rl.color;
  if(state.plan){
    set('gEta','T+'+fmt(state.plan.stationT-T0)+(state.plan.stationOk?'':' ⚠'));
    set('gWindow',`T+${fmt(STATION.winOpen*HOUR)} ~ T+${fmt(STATION.winClose*HOUR)}`);
    set('gEtaEnd','T+'+fmt(state.plan.endT-T0));
    // 下一段盲区
    const gap=nextCommGap();
    if(!state.online){
      set('gBlackout', gap?`恢复于 T+${fmt(gap.exit-T0)}（还需 ${fmt(gap.exit-state.t)}）`:'盲区直至补给点');
    } else {
      set('gBlackout',gap?`T+${fmt(gap.enter-T0)} 起，持续 ${fmt(gap.exit-gap.enter)}`:'无计划内盲区');
    }
  }
  updateCommUI();
}
function set(id,v){document.getElementById(id).textContent=v;}
function updateCommUI(){
  const pill=document.getElementById('commPill'), txt=document.getElementById('commText');
  pill.classList.toggle('off',!state.online);
  txt.textContent=state.online?'链路在线（卫星/基站）':'通信中断 · 离线模式';
  document.getElementById('offlineBanner').classList.toggle('hidden',state.online||state.arrived);
}

/* ---------------- 连锁影响分析 ---------------- */
// 计算计划中的通信盲区（从当前船位沿路径按 0.25h 采样）
function nextCommGap(){
  if(!state.plan) return null;
  const stepQ=0.25*HOUR;
  let t=state.t, s=state.s, outside=null;
  let guard=0;
  while(t<state.plan.stationT && guard++<800){
    const p=posAt(s);
    const ice=iceAt(p,t), vis=visibilityAt(p,t);
    const v=Math.max(1,effectiveSpeed(planSpeedAt(s),ice,vis));
    if(!inComm(p)){ if(!outside) outside={enter:t,enterS:s}; }
    else if(outside){ return {enter:outside.enter,exit:t,enterS:outside.enterS,exitS:s}; }
    t+=stepQ; s+=v*.25;
    if(s>=state.path.total) break;
  }
  if(outside) return {enter:outside.enter,exit:state.plan.stationT,enterS:outside.enterS,exitS:state.path.total};
  return null;
}

function renderChain(){
  const el=document.getElementById('tabChain');
  const p=state.plan; if(!p){el.innerHTML='';return;}
  const cards=[];
  const gap=nextCommGap();
  const highSegs=p.segData.filter(d=>d.iceMax>=0.6);
  const arriveH=p.arriveH;
  const delayH=Math.max(0,arriveH-STATION.winClose);
  const earlyH=Math.max(0,STATION.winOpen-arriveH);

  // 1) 高风险冰带穿越
  if(highSegs.length){
    const segs=highSegs.map(d=>`航段${d.seg+1}`).join('、');
    const maxIce=Math.max(...highSegs.map(d=>d.iceMax));
    cards.push({sev:maxIce>=.8?'high':'mid',title:'🧊 路线穿越高风险冰带',
      body:`计划航线在 ${segs} 进入风险 ${(maxIce*100).toFixed(0)}% 的冰带密集区。`,
      flow:['冰带漂移压缩航道','实际航速下降 30–62%','抵达时间整体后移','可能错过补给窗口']});
  }
  // 2) 补给窗口
  if(!p.stationOk){
    if(p.stationNote==='late'){
      cards.push({sev:'high',title:'⛔ 错过补给窗口',
        body:`预计 T+${fmt(p.stationT-T0)} 抵达，晚于窗口关闭（T+${fmt(STATION.winClose*HOUR)}）约 ${delayH.toFixed(1)} 小时。`,
        flow:['冰区减速/等待','ETA 后移 '+delayH.toFixed(1)+'h','补给站关闭','无法补料 → 后续航段燃料风险']});
    }else{
      cards.push({sev:'mid',title:'⏳ 早于补给窗口',
        body:`预计 T+${fmt(p.stationT-T0)} 抵达，窗口 T+${fmt(STATION.winOpen*HOUR)} 才开启，需在站外等待 ${earlyH.toFixed(1)} 小时（计入冰区暴露）。`,
        flow:['航速过高/路线过短','早到 '+earlyH.toFixed(1)+'h','站外漂泊等待','期间持续受风/冰漂移影响']});
    }
  }
  // 3) 燃料
  if(p.fuelAtStation<25){
    cards.push({sev:p.fuelAtStation<10?'high':'mid',title:'⛽ 燃料安全余量不足',
      body:`抵达补给点时预计仅剩 ${p.fuelAtStation.toFixed(1)}% 燃料。`,
      flow:[p.fuelAtStation<10?'燃料可能在途中耗尽':'低于 25% 安全线','一旦绕冰/加时等待','无动力漂浮于冰区']});
  }
  if(p.depleted||p.fuelAtStation<=0){
    cards.push({sev:'high',title:'☠ 计划航线下燃料将耗尽',
      body:'按当前航速与绕航距离，燃料无法支撑到补给点。',flow:['油耗 > 初始储备','途中失去动力']});
  }
  // 4) 通信盲区
  if(gap){
    const dur=(gap.exit-gap.enter)/HOUR;
    cards.push({sev:dur>6?'high':'mid',title:'📡 计划航线穿越通信盲区',
      body:`预计 T+${fmt(gap.enter-T0)} 驶出覆盖，盲区持续约 ${dur.toFixed(1)} 小时（${(gap.exitS-gap.enterS).toFixed(0)} nmi）。`,
      flow:['驶出卫星/基站覆盖','链路中断 '+dur.toFixed(1)+'h','期间操作进入离线队列','恢复后需校验合并',
            ...(highSegs.length?['盲区恰与高风险冰带重叠 → 无法实时请求支援']:[])]});
  }
  // 5) 低能见度
  const fogSegs=p.segData.filter(d=>d.visMin<2);
  if(fogSegs.length){
    cards.push({sev:'low',title:'🌫 低能见度航段',
      body:`航段 ${fogSegs.map(d=>d.seg+1).join('、')} 能见度低于 2 nmi，建议减速并加强瞭望。`,
      flow:['雾团覆盖','能见度 <2 nmi','安全航速下降','单位油耗上升约 25%']});
  }

  let html;
  if(!cards.length){
    html=`<div class="chain-ok">✅ 当前计划未发现连锁风险：<br>
      · 所有航段冰况风险可控<br>· 预计 T+${fmt(p.stationT-T0)} 在补给窗口内抵达<br>
      · 计划燃料余量 ${p.fuelAtStation.toFixed(1)}%${gap?'':'<br>· 全程处于通信覆盖内'}</div>`;
  }else{
    html=cards.map(c=>`<div class="chain-card sev-${c.sev}"><h4>${c.title}</h4><p>${c.body}</p>
      <div class="chain-flow">${c.flow.map((f,i)=>`<span>${f}</span>${i<c.flow.length-1?'<i>→</i>':''}`).join('')}</div></div>`).join('');
  }
  el.innerHTML=html;
}

/* ---------------- 航段逐小时风险 ---------------- */
function renderSegment(segIdx){
  const el=document.getElementById('segInfo');
  const wps=state.waypoints;
  if(segIdx==null||segIdx<0||segIdx>=wps.length-1){
    el.className='seg-empty';
    el.textContent='点击海图上的航线选择航段，查看未来数小时的逐小时通行风险。';
    state.selectedSeg=null;return;
  }
  state.selectedSeg=segIdx;
  el.className='';
  // 找到该航段在路径上的距离范围
  const breaks=state.path.segBreaks;
  const sFrom=segIdx===0?0:breaks[segIdx-1];
  const sTo=breaks[segIdx];
  // 推演到该航段入口时刻（从当前状态按段推进）
  const entry=enterTimeOf(segIdx);
  // 若航段在船后方，仅给出历史说明
  if(sTo<=state.s){
    el.innerHTML=`<div class="seg-head">航段 <b>${segIdx+1}</b>（${(sTo-sFrom).toFixed(0)} nmi）</div>
      <div class="seg-empty">该航段已经驶过。可在「推演历史」中回到对应节点重新推演。</div>`;
    return;
  }
  // 直接在计划器积分轨迹的“本航段”区间上插值，保证与 ETA 完全一致
  const trace=state.plan.trace.filter(p=>p.s>=sFrom-1e-6 && p.s<=sTo+1e-6);
  function sAtTime(tq){
    if(!trace.length) return sFrom;
    if(tq<=trace[0].t) return trace[0].s;
    for(let i=1;i<trace.length;i++){
      if(tq<=trace[i].t){
        const a=trace[i-1],b=trace[i],f=(tq-a.t)/((b.t-a.t)||1);
        return lerp(a.s,b.s,f);
      }
    }
    return trace[trace.length-1].s;
  }
  const rows=[];
  const collect=(tq)=>{
    const sAt=clamp(sAtTime(tq),sFrom,sTo);
    const pp=posAt(sAt);
    const ice=iceAt(pp,tq),vis=visibilityAt(pp,tq),w=windAt(tq);
    rows.push({t:tq,ice:ice.risk,vis,wind:w.speed,online:inComm(pp),belt:ice.belt});
  };
  collect(entry.t);
  let nextWhole=Math.ceil((entry.t-T0)/HOUR)*HOUR+T0;
  while(nextWhole<entry.exitT-60000 && rows.length<8){
    collect(nextWhole); nextWhole+=HOUR;
  }
  if(entry.exitT>entry.t+300000) collect(entry.exitT);
  const maxIce=Math.max(...rows.map(r=>r.ice));
  const minVis=Math.min(...rows.map(r=>r.vis));
  const offH=rows.filter(r=>!r.online).length;
  el.innerHTML=`<div class="seg-head">航段 <b>${segIdx+1}</b> · ${wps[segIdx].id==='wp0'?'起点':'WP'+segIdx} → ${segIdx+1===wps.length-1?'补给站':'WP'+(segIdx+1)}
    （${(sTo-sFrom).toFixed(0)} nmi）</div>
  <div class="seg-stat">
    <div class="chip">入口时刻<b>T+${fmt(entry.t-T0)}</b></div>
    <div class="chip">峰值冰况<b>${(maxIce*100).toFixed(0)}%</b></div>
    <div class="chip">最低能见<b>${minVis.toFixed(1)} nmi</b></div>
  </div>
  <div class="seg-stat">
    <div class="chip">预计耗时<b>${((entry.exitT-entry.t)/HOUR).toFixed(1)} h</b></div>
    <div class="chip">离线时长<b>${offH} h</b></div>
  </div>
  <div style="font-size:11px;color:var(--dim);margin:6px 0 2px">未来逐小时（冰况风险 / 环境）</div>
  ${rows.map(r=>{const rl=riskLabel(r.ice);return `
  <div class="hr-row">
    <span class="h-time">T+${fmt(r.t-T0)}<br><span class="hr-sub">+${((r.t-entry.t)/HOUR).toFixed(1)}h</span></span>
    <div>
      <div class="hr-bar"><i class="${rl.cls}" style="width:${(r.ice*100).toFixed(0)}%"></i></div>
      <div class="hr-sub">${rl.t}${r.belt?' · '+r.belt.id:''} · 能见${r.vis.toFixed(1)} · 风${r.wind.toFixed(0)}kn · ${r.online?'在线':'<span style="color:var(--red)">离线</span>'}</div>
    </div>
    <span class="h-val" style="color:${rl.color}">${(r.ice*100).toFixed(0)}%</span>
  </div>`;}).join('')}`;
}
// 计算指定航段的入口/出口时刻与入口航程
function enterTimeOf(segIdx){
  const breaks=state.path.segBreaks;
  const sFrom=segIdx===0?0:breaks[segIdx-1];
  const sTo=breaks[segIdx];
  const sd=state.plan.segData.find(d=>d.seg===segIdx);
  // 若该段已在船后方（不在计划 segData 中），按 12kn 给出历史近似
  if(!sd){
    const mid=(sFrom+sTo)/2;
    return {t:state.t,exitT:state.t+(sTo-sFrom)/SPEED_DEFAULT*HOUR,sEnter:sFrom};
  }
  return {t:sd.enterT,exitT:sd.exitT,sEnter:sFrom};
}

/* ---------------- 时间轴 ---------------- */
const tlTrack=document.getElementById('tlTrack');
function tlPct(t){return clamp((t-T0)/(MAX_PLAN_H*HOUR)*100,0,100);}
function renderTimeline(){
  // 刻度
  const labels=document.getElementById('tlLabels');
  labels.innerHTML='';
  for(let h=0;h<=MAX_PLAN_H;h+=4){
    const sp=document.createElement('span');
    sp.style.left=(h/MAX_PLAN_H*100)+'%';
    sp.textContent='T+'+h+'h';
    labels.appendChild(sp);
  }
  // 补给窗口/冰带/盲区（基于计划采样）
  const iceEl=document.getElementById('tlIce');iceEl.innerHTML='';
  const commEl=document.getElementById('tlComm');commEl.innerHTML='';
  const waitEl=document.getElementById('tlWait');waitEl.innerHTML='';
  const nodesEl=document.getElementById('tlNodes');nodesEl.innerHTML='';
  if(!state.plan) return;
  // 冰况条：沿计划逐 0.25h
  let t=state.t,s=state.s,segStartT=null,segClass=null,segStartS=0;
  let guard=0;
  const iceSegs=[];
  while(t<state.plan.stationT&&guard++<900){
    const p=posAt(s);
    const ice=iceAt(p,t),vis=visibilityAt(p,t);
    const v=Math.max(1,effectiveSpeed(planSpeedAt(s),ice,vis));
    const rl=ice.risk>=.75?'risk-crit':ice.risk>=.5?'risk-high':ice.risk>=.25?'risk-mid':'risk-low';
    if(rl!==segClass){
      if(segClass&&segClass!=='risk-low')iceSegs.push([segStartT,t,segClass]);
      segClass=rl;segStartT=t;
    }
    t+=.25*HOUR;s+=v*.25;
    if(s>=state.path.total)break;
  }
  if(segClass&&segClass!=='risk-low')iceSegs.push([segStartT,t,segClass]);
  const colors={ 'risk-mid':'rgba(245,185,74,.7)','risk-high':'rgba(242,139,74,.8)','risk-crit':'rgba(242,99,94,.9)' };
  iceSegs.forEach(([a,b,c])=>{
    const d=document.createElement('div');
    d.className='seg';
    d.style.left=tlPct(a)+'%';d.style.width=Math.max(.5,tlPct(b)-tlPct(a))+'%';
    d.style.background=colors[c];
    iceEl.appendChild(d);
  });
  // 通信盲区
  const gap=nextCommGap();
  if(gap){
    const d=document.createElement('div');
    d.className='seg';
    d.style.left=tlPct(gap.enter)+'%';
    d.style.width=Math.max(.5,tlPct(gap.exit)-tlPct(gap.enter))+'%';
    commEl.appendChild(d);
  }
  // 等待窗口
  (state.plan.events||[]).forEach(ev=>{
    if(ev.type!=='wait')return;
    const d=document.createElement('div');
    d.className='seg';
    d.style.left=tlPct(ev.t)+'%';
    d.style.width=Math.max(.5,ev.hours/MAX_PLAN_H*100)+'%';
    waitEl.appendChild(d);
  });
  // 历史节点
  state.history.forEach(n=>{
    const d=document.createElement('div');
    d.className='node';
    d.style.left=tlPct(n.t)+'%';
    d.style.background=n.color;
    d.title=`${n.label} · T+${fmt(n.t-T0)}`;
    if(n===state.currentNode) d.style.boxShadow=`0 0 8px ${n.color}`;
    d.onclick=()=>restoreNode(n);
    nodesEl.appendChild(d);
  });
  renderTimelineCursor();
}
function renderTimelineCursor(){
  const cur=document.getElementById('tlCursor');
  cur.style.left=tlPct(state.t)+'%';
}
function flashTimeline(msg){document.getElementById('tlInfoText').textContent=msg;}

/* ---------------- 历史 / 离线面板 ---------------- */
function renderHistory(){
  const el=document.getElementById('tabHist');
  if(!state.history.length){el.innerHTML='<div class="hist-empty">尚无历史节点。开始推演后，系统会在通信状态变化、抵达、改线与每 2 小时处自动记录节点；点击时间轴上的节点可回到该时刻重新推演。</div>';return;}
  el.innerHTML=state.history.slice().reverse().map(n=>`
    <div class="hist-node ${n===state.currentNode?'current':''}" data-id="${n.id}">
      <div class="n-dot" style="background:${n.color}"></div>
      <div class="n-body">
        <div class="n-time">T+${fmt(n.t-T0)} · ${fmtClock(n.t)}</div>
        <div class="n-title">${n.label}</div>
        <div class="n-branch">${n.branch}${n===state.currentNode?' · 当前':''}</div>
      </div>
    </div>`).join('');
  el.querySelectorAll('.hist-node').forEach(d=>{
    d.onclick=()=>{const n=state.history.find(x=>x.id===d.dataset.id);if(n)restoreNode(n);};
  });
}
function renderOps(){
  const el=document.getElementById('tabOps');
  const badge=(n)=>{
    document.querySelectorAll('.tab[data-tab=ops]').forEach(b=>b.textContent=n?`离线操作 (${n})`:'离线操作');
  };
  badge(state.pendingOps.length);
  if(!state.pendingOps.length){
    el.innerHTML=`<div class="ops-empty">离线队列为空。<br>当船舶驶出通信覆盖（海图虚线圆之外）时，对航路点、航速或等待窗口的修改不会立即生效，而是进入此队列；
    通信恢复后，系统将以恢复时刻为基线逐项校验：<br>
    · <span style="color:var(--teal)">有效操作</span> 自动合并并重新计算 ETA；<br>
    · <span style="color:var(--red)">冲突操作</span>（航点已越过、穿陆、过冰带等）被拒绝并说明原因。</div>`;
    return;
  }
  el.innerHTML=state.pendingOps.map(o=>{
    const st=o.status==='ok'?'<span class="status-ok">✓ 已合并</span>'
      :o.status==='rej'?`<span class="status-rej">✗ 已拒绝</span>`
      :'<span class="status-pending">⏱ 待合并</span>';
    return `<div class="ops-item">
      <div class="ops-head"><b>${o.label}</b>${st}</div>
      <div style="color:var(--dim)">记录于 T+${fmt(o.baseT-T0)}（离线中）</div>
      <div>${o.detail||''}</div>
      ${o.rejectReason?`<div style="color:var(--red);margin-top:3px">原因：${o.rejectReason}</div>`:''}
    </div>`;}).join('');
}

/* ---------------- 轻提示 ---------------- */
let toastTimer=null;
function toast(msg){
  let t=document.getElementById('appToast');
  if(!t){
    t=document.createElement('div');t.id='appToast';
    t.style.cssText='position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(13,25,37,.95);border:1px solid #27506e;color:var(--txt);padding:9px 16px;border-radius:8px;font-size:12px;z-index:30;opacity:0;transition:.3s;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent=msg;t.style.opacity='1';
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.style.opacity='0',2600);
}

/* ---------------- 交互：航路点编辑 ---------------- */
function nearestWaypoint(wp, tol=11){
  for(let i=0;i<state.waypoints.length;i++){
    const w=state.waypoints[i];
    const s=toScreen(w);
    if(Math.hypot(wp.x-s.x,wp.y-s.y)<tol) return {w,i};
  }
  return null;
}
function nearestSegment(m, tol=8){
  let best=null;
  for(let i=0;i<state.waypoints.length-1;i++){
    const a=toScreen(state.waypoints[i]),b=toScreen(state.waypoints[i+1]);
    const r=segHit(m,a,b,tol);
    if(r.d<tol && (!best||r.d<best.d)) best={seg:i,t:r.t,d:r.d};
  }
  return best;
}
let downInfo=null;
canvas.addEventListener('mousedown',e=>{
  const rect=canvas.getBoundingClientRect();
  const m={x:e.clientX-rect.left,y:e.clientY-rect.top};
  const wp=nearestWaypoint(m);
  downInfo={m,wp,moved:false,time:performance.now()};
  if(wp){
    // 已经驶过的航路点不可拖动
    const breaks=state.path.segBreaks;
    const wpS=wp.i===0?0:breaks[wp.i-1]??0;
    downInfo.passed = wpS<state.s-1;
    if(!downInfo.passed) state.dragging=wp.w;
  }
});
canvas.addEventListener('mousemove',e=>{
  const rect=canvas.getBoundingClientRect();
  const m={x:e.clientX-rect.left,y:e.clientY-rect.top};
  if(downInfo&&state.dragging){
    if(Math.hypot(m.x-downInfo.m.x,m.y-downInfo.m.y)>3) downInfo.moved=true;
    const world=toWorld(m.x,m.y);
    world.x=clamp(world.x,10,W-10);world.y=clamp(world.y,10,H-10);
    if(onLand(world)){canvas.style.cursor='not-allowed';}
    else {state.dragging.x=world.x;state.dragging.y=world.y;}
    canvas.style.cursor='grabbing';
    recompute();
    return;
  }
  // hover
  const wp=nearestWaypoint(m);
  const seg=wp?null:nearestSegment(m);
  canvas.style.cursor=wp?'grab':seg?'pointer':'crosshair';
  const tip=document.getElementById('hoverTip');
  if(wp){
    const passed=downInfo?false:false;
    tip.classList.remove('hidden');
    tip.style.left=(m.x+14)+'px';tip.style.top=(m.y+14)+'px';
    tip.innerHTML=`<b>航路点 WP${wp.i}</b><br>拖动改线 · 双击设置等待/航速${wp.w.wait?`<br><span style="color:var(--purple)">等待 ${wp.w.wait}h</span>`:''}`;
  }else tip.classList.add('hidden');
});
window.addEventListener('mouseup',e=>{
  if(!downInfo) return;
  const wasDrag=downInfo.moved;
  const hit=downInfo.wp;
  if(state.dragging && wasDrag && hit){
    const target={x:hit.w.x,y:hit.w.y};
    submitEdit(`拖动航路点 WP${hit.i}`,
      `新位置 (${target.x.toFixed(0)}, ${target.y.toFixed(0)})`,
      ()=>{
        const w=state.waypoints.find(x=>x.id===hit.w.id);
        if(w){w.x=target.x;w.y=target.y;}
      },
      ()=>{
        if(!routeValid()) return '新路线穿越陆地或航程过短';
        if(hit.i>0&&state.path.segBreaks[hit.i-1]<state.s-1) return '该航路点已经驶过';
        if(maxRouteIce()>0.92) return '路线进入极危险冰带核心（风险 >92%）';
        return true;
      });
  }
  state.dragging=null;
  downInfo=null;
});
canvas.addEventListener('click',e=>{
  if(downInfo&&downInfo.moved) return;
  const rect=canvas.getBoundingClientRect();
  const m={x:e.clientX-rect.left,y:e.clientY-rect.top};
  const seg=nearestSegment(m);
  if(seg){ renderSegment(seg.seg); switchTab('risk'); }
});
canvas.addEventListener('dblclick',e=>{
  const rect=canvas.getBoundingClientRect();
  const m={x:e.clientX-rect.left,y:e.clientY-rect.top};
  const wp=nearestWaypoint(m);
  if(!wp||wp.w.locked) return;
  if(wp.i>0 && state.path.segBreaks[wp.i-1]<state.s-1){
    toast('该航路点已经驶过，只能调整前方航路点');
    return;
  }
  openWpModal(wp.w,wp.i);
});

// 航路编辑统一入口
// reapply: 在当前 state 上执行编辑（在线提交与离线合并时都会调用）
// validate: 可选，返回 true 或错误原因字符串
function submitEdit(label, detail, reapply, validate){
  if(state.online){
    const shipPos=posAt(state.s);
    reapply();
    const v=validate?validate():true;
    if(v!==true){ toast('操作被拒绝：'+v); recompute(); return false; }
    rebaseShip(shipPos);
    recompute();
    if(state.s>0&&!state.arrived) branchFork(label); else snapshot(label,'edit');
    return true;
  }
  // 离线：先在“进入盲区前基线”的副本上预检（航路点是否已越过、路线是否穿陆）
  const saved=JSON.parse(JSON.stringify({waypoints:state.waypoints}));
  saved.speed=state.speed;
  reapply();
  const v=validate?validate():true;
  // 恢复当前画面（仍临时展示，由调用方决定）
  state.waypoints=saved.waypoints; state.speed=saved.speed;
  if(v!==true){ toast('离线操作预检未通过：'+v); recompute(); return false; }
  // 通过预检：临时应用并进入合并队列
  const shipPos=posAt(state.s);
  reapply();
  rebaseShip(shipPos);
  recompute();
  queueOp({label, detail, reapply, validate:validate||null});
  return true;
}
// 编辑航线后，按世界坐标把船重新投影到新航线上，避免累积航程跳变
function rebaseShip(shipPos){
  if(state.s<=0||state.arrived) return;
  const path=buildPath(state.waypoints);
  let best=0,bestD=Infinity;
  for(let i=0;i<path.pts.length-1;i++){
    const a=path.pts[i],b=path.pts[i+1];
    const abx=b.x-a.x,aby=b.y-a.y;
    const t=clamp(((shipPos.x-a.x)*abx+(shipPos.y-a.y)*aby)/(abx*abx+aby*aby||1),0,1);
    const px=a.x+abx*t,py=a.y+aby*t;
    const d=Math.hypot(shipPos.x-px,shipPos.y-py);
    if(d<bestD){bestD=d;best=a.s+t*(b.s-a.s);}
  }
  state.s=clamp(best,0,path.total);
}

/* ---------------- 航路点弹窗（等待窗口 / 速度 / 删除） ---------------- */
const modalMask=document.getElementById('modalMask');
function openWpModal(wp,idx){
  state.modalWp={wp,idx};
  document.getElementById('wpModalTitle').textContent='WP'+idx;
  const wr=document.getElementById('wpWaitRange');
  wr.value=wp.wait||0;document.getElementById('wpWaitVal').textContent=(wp.wait||0)+' h';
  const useCustom=wp.customSpeed!=null;
  document.getElementById('wpLockSpeed').checked=useCustom;
  const sr=document.getElementById('wpSpeedRange');
  sr.disabled=!useCustom;sr.value=wp.customSpeed??state.speed;
  document.getElementById('wpSpeedVal').textContent=(wp.customSpeed??state.speed).toFixed(1)+' kn';
  document.getElementById('wpDelete').style.visibility=idx>0&&idx<state.waypoints.length-1?'visible':'hidden';
  modalMask.classList.remove('hidden');
}
document.getElementById('wpWaitRange').addEventListener('input',e=>{
  document.getElementById('wpWaitVal').textContent=e.target.value+' h';
});
document.getElementById('wpLockSpeed').addEventListener('change',e=>{
  document.getElementById('wpSpeedRange').disabled=!e.target.checked;
});
document.getElementById('wpSpeedRange').addEventListener('input',e=>{
  document.getElementById('wpSpeedVal').textContent=Number(e.target.value).toFixed(1)+' kn';
});
document.getElementById('wpCancel').onclick=()=>modalMask.classList.add('hidden');
document.getElementById('wpApply').onclick=()=>{
  const {wp,idx}=state.modalWp;
  const wait=Number(document.getElementById('wpWaitRange').value);
  const useCustom=document.getElementById('wpLockSpeed').checked;
  const customSpeed=useCustom?Number(document.getElementById('wpSpeedRange').value):null;
  applyWpSettings(idx,wait,customSpeed);
  modalMask.classList.add('hidden');
};
document.getElementById('wpDelete').onclick=()=>{
  const {idx}=state.modalWp;
  deleteWaypoint(idx);
  modalMask.classList.add('hidden');
};
function wpPassed(idx){
  if(idx<=0) return false;
  return state.path.segBreaks[idx-1]<state.s-1;
}
function routeValid(){
  const path=buildPath(state.waypoints);
  for(let i=0;i<path.pts.length;i++) if(onLand(path.pts[i])) return false;
  if(path.total<60) return false;
  return true;
}
function maxRouteIce(){
  const path=buildPath(state.waypoints);let m=0;
  for(let i=0;i<path.pts.length;i+=20) m=Math.max(m,iceAt(path.pts[i],state.t).risk);
  return m;
}
function applyWpSettings(idx,wait,customSpeed){
  submitEdit(
    `WP${idx} 等待 ${wait}h${customSpeed!=null?` / ${customSpeed}kn`:''}`,
    '离线期间提交的等待/航速设置',
    ()=>{
      state.waypoints[idx].wait=wait;
      if(customSpeed==null) delete state.waypoints[idx].customSpeed;
      else state.waypoints[idx].customSpeed=customSpeed;
    },
    ()=>wpPassed(idx)?'该航路点已经驶过':true
  );
}
function deleteWaypoint(idx){
  if(state.waypoints[idx].locked){toast('端点航路点不可删除');return;}
  if(wpPassed(idx)){toast('该航路点已经驶过，无法删除');return;}
  submitEdit(`删除航路点 WP${idx}`,'离线期间提交的删除操作',
    ()=>{ state.waypoints.splice(idx,1); },
    ()=>routeValid()?true:'删除后路线无效（穿陆/过短）'
  );
}

/* ---------------- 顶部控制 ---------------- */
const btnPlay=document.getElementById('btnPlay');
function updatePlayBtn(){btnPlay.textContent=state.playing?'⏸ 暂停':(state.arrived?'已抵达 · 重置':state.s>0?'▶ 继续推演':'▶ 开始推演');}
btnPlay.onclick=()=>{
  if(state.arrived){resetMission();return;}
  state.playing=!state.playing;
  if(state.playing&&state.s===0) snapshot('任务开始','start');
  updatePlayBtn();
};
document.getElementById('rateGroup').addEventListener('click',e=>{
  if(e.target.dataset.rate){
    state.rate=Number(e.target.dataset.rate);
    document.querySelectorAll('#rateGroup button').forEach(b=>b.classList.toggle('active',b===e.target));
  }
});
document.getElementById('btnJump').onclick=()=>{
  state.playing=false;updatePlayBtn();
  advance(1);
  flashTimeline('⏩ 手动快进 1 小时');
};
document.getElementById('btnReset').onclick=resetMission;
function resetMission(){
  if(!confirm('重置整个任务？所有历史分支与离线队列将被清空。'))return;
  Object.assign(state,{
    waypoints:defaultWaypoints(),speed:SPEED_DEFAULT,t:T0,playing:false,
    s:0,fuel:FUEL_START,waitingUntil:0,track:[],selectedSeg:null,online:true,
    pendingOps:[],offlineBase:null,history:[],currentNode:null,branchSeq:0,arrived:false,refueled:false,
  });
  document.getElementById('speedRange').value=SPEED_DEFAULT;
  document.getElementById('speedVal').textContent=SPEED_DEFAULT.toFixed(1)+' kn';
  recompute();updateClock();renderHistory();renderOps();renderSegment(null);
  updatePlayBtn();flashTimeline('任务已重置');
}
document.getElementById('speedRange').addEventListener('input',e=>{
  const v=Number(e.target.value);
  document.getElementById('speedVal').textContent=v.toFixed(1)+' kn';
  applySpeed(v);
});
let speedInputTimer=null;
function applySpeed(v){
  clearTimeout(speedInputTimer);
  speedInputTimer=setTimeout(()=>{
    submitEdit(`计划航速调整为 ${v} kn`,'离线期间提交的航速修改',
      ()=>{ state.speed=v; },
      ()=>(v<SPEED_MIN||v>SPEED_MAX)?'航速超出允许范围':true
    );
  },400);
}

/* ---------------- 选项卡 / 时间轴点击 ---------------- */
document.querySelectorAll('.tab').forEach(tab=>{
  tab.onclick=()=>switchTab(tab.dataset.tab);
});
function switchTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  ['risk','chain','hist','ops'].forEach(n=>
    document.getElementById('tab'+n[0].toUpperCase()+n.slice(1)).classList.toggle('hidden',n!==name));
}
tlTrack.addEventListener('click',e=>{
  if(e.target.classList.contains('node'))return;
  const rect=tlTrack.getBoundingClientRect();
  const frac=(e.clientX-rect.left)/rect.width;
  const t=T0+frac*MAX_PLAN_H*HOUR;
  // 回到不晚于该时刻的最近历史节点
  const past=state.history.filter(n=>n.t<=t);
  if(past.length){restoreNode(past[past.length-1]);flashTimeline('已回到最近历史节点，可从此处重新推演');}
  else toast('任务开始前没有可恢复的历史节点');
});

/* ---------------- 启动 ---------------- */
resize();
recompute();
updateClock();
renderHistory();
renderOps();
renderSegment(null);
updatePlayBtn();
renderTimeline();
flashTimeline('准备就绪：可直接开始推演，或先拖动航路点 / 调整航速进行规划');
requestAnimationFrame(function loop(t){lastFrame=t;requestAnimationFrame(frame);});
