import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const JUNE = 1780272000000;

// ── resolved, priced Helix calls with conviction (dismissed already excl.) ──
const rowsAll = (await db.execute(`
  SELECT o.conviction AS c, o.realized_pct AS r, o.generated_at AS t, o.asset_id AS a
  FROM signal_outcomes o
  LEFT JOIN signals s ON s.id = o.signal_id
  WHERE o.outcome IN ('target_hit','stop_hit','flat')
    AND o.price_at_outcome IS NOT NULL AND o.conviction IS NOT NULL
    AND COALESCE(o.framework_version,'v1')='v1' AND o.signal_id NOT LIKE '%-shadow-v2'
  ORDER BY o.generated_at ASC`)).rows.map(x => ({ c: Number(x.c), r: Number(x.r), t: Number(x.t), a: String(x.a) }));

// BTC daily closes for the equity-vs-BTC comparison
const btc = (await db.execute(`SELECT date, close FROM klines_daily WHERE asset_id='tok-btc' ORDER BY date ASC`)).rows
  .map(x => ({ date: x.date, close: Number(x.close) }));
function btcClose(ms) { const d = new Date(ms).toISOString().slice(0,10); let best=null; for (const k of btc){ if (k.date<=d) best=k.close; else break; } return best; }

// ── helpers ──
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
function wilson(k, n, z=1.96){ if(!n) return [null,null]; const p=k/n, d=1+z*z/n; const c=(p+z*z/(2*n))/d; const m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return [c-m,c+m]; }
function brier(rows){ let s=0; for(const x of rows){ const y=x.r>0?1:0; s+=(x.c-y)**2; } return rows.length? s/rows.length : null; }
function baselineBrier(rows){ const p=rows.filter(x=>x.r>0).length/rows.length; return p*(1-p); }
function pct(a,p){ const s=[...a].sort((x,y)=>x-y); const i=Math.min(s.length-1,Math.max(0,Math.floor(p*(s.length-1)))); return s[i]; }
// deterministic LCG (Math.random is fine here, but keep it reproducible)
let seed=12345; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
function bootstrap(rows, stat, B=20000){ const out=[]; const n=rows.length; for(let b=0;b<B;b++){ const s=new Array(n); for(let i=0;i<n;i++) s[i]=rows[(rnd()*n)|0]; out.push(stat(s)); } return [pct(out,0.025), pct(out,0.975)]; }
function auc(rows){ const w=rows.filter(x=>x.r>0).map(x=>x.c), l=rows.filter(x=>x.r<=0).map(x=>x.c); if(!w.length||!l.length) return null; let s=0; for(const a of w) for(const b of l) s += a>b?1:(a===b?0.5:0); return s/(w.length*l.length); }
// 1-feature logistic (Platt) via gradient ascent on centered/scaled conviction
function platt(rows){ const xs=rows.map(x=>x.c), ys=rows.map(x=>x.r>0?1:0); const mx=mean(xs), sx=Math.sqrt(mean(xs.map(v=>(v-mx)**2)))||1; const z=xs.map(v=>(v-mx)/sx); let a=0,b=0,lr=0.1; for(let it=0;it<60000;it++){ let ga=0,gb=0; for(let i=0;i<z.length;i++){ const p=1/(1+Math.exp(-(a+b*z[i]))); ga+=(ys[i]-p); gb+=(ys[i]-p)*z[i]; } a+=lr*ga/z.length; b+=lr*gb/z.length; } const predAtRaw=v=>1/(1+Math.exp(-(a+b*((v-mx)/sx)))); return { a,b_scaled:b, predAtRaw }; }

function report(label, rows){
  console.log(`\n========== ${label}  (n=${rows.length}) ==========`);
  const wins=rows.filter(x=>x.r>0), losses=rows.filter(x=>x.r<=0);
  const wr=wins.length/rows.length, aw=mean(wins.map(x=>x.r)), al=mean(losses.map(x=>x.r));
  console.log(`— Q1 EXPECTANCY —`);
  console.log(`  win rate ${(wr*100).toFixed(1)}%  (Wilson95 [${wilson(wins.length,rows.length).map(v=>(v*100).toFixed(0)).join(', ')}]%)`);
  console.log(`  avg win  +${aw.toFixed(2)}%   avg loss ${al.toFixed(2)}%   (loss = realized<=0)`);
  const gross=mean(rows.map(x=>x.r));
  console.log(`  gross expectancy / signal = ${gross.toFixed(3)}%   (= mean realized)`);
  for(const cost of [0.20,0.40]){ const net=gross-cost; console.log(`  net expectancy @ ${cost.toFixed(2)}% round-trip cost = ${net.toFixed(3)}% / signal  → over ${rows.length} signals additive = ${(net*rows.length).toFixed(1)}%`); }
  // equity: sequential compounding, full size, net of 0.20%
  let eq=1, peak=1, maxdd=0; for(const x of rows){ eq*=(1+(x.r-0.20)/100); peak=Math.max(peak,eq); maxdd=Math.min(maxdd,eq/peak-1); }
  const b0=btcClose(rows[0].t), b1=btcClose(rows.at(-1).t); const btcRet=b0&&b1? (b1/b0-1)*100 : null;
  console.log(`  equity (compound, full size, net 0.20%) = ${((eq-1)*100).toFixed(1)}%  · maxDD ${(maxdd*100).toFixed(1)}%`);
  console.log(`  BTC buy&hold over same window (${new Date(rows[0].t).toISOString().slice(0,10)}→${new Date(rows.at(-1).t).toISOString().slice(0,10)}) = ${btcRet==null?'—':btcRet.toFixed(1)+'%'}`);

  console.log(`— Q2 ERROR BARS —`);
  const bins=[[0.5,0.6],[0.6,0.7],[0.7,0.8]];
  for(const [lo,hi] of bins){ const inb=rows.filter(x=>x.c>=lo&&x.c<hi); const k=inb.filter(x=>x.r>0).length; if(inb.length){ const [wl,wh]=wilson(k,inb.length); console.log(`  conv ${lo.toFixed(2)}-${hi.toFixed(2)}: n=${inb.length} hit=${(k/inb.length*100).toFixed(0)}%  Wilson95 [${(wl*100).toFixed(0)}, ${(wh*100).toFixed(0)}]%`); } }
  const B=brier(rows), base=baselineBrier(rows);
  const [bl,bh]=bootstrap(rows, brier);
  const [dl,dh]=bootstrap(rows, s=>brier(s)-baselineBrier(s));
  console.log(`  Brier ${B.toFixed(4)}  (boot95 [${bl.toFixed(4)}, ${bh.toFixed(4)}])   baseline ${base.toFixed(4)}`);
  console.log(`  (Brier − baseline) = ${(B-base).toFixed(4)}  boot95 [${dl.toFixed(4)}, ${dh.toFixed(4)}]  → skill distinguishable from 0? ${(dl>0||dh<0)?'YES':'NO (CI contains 0)'}`);

  console.log(`— Q3 RANK TEST —`);
  const A=auc(rows); const [al2,ah2]=bootstrap(rows, s=>auc(s)??0.5);
  console.log(`  AUC(conviction, win) = ${A==null?'—':A.toFixed(3)}  boot95 [${al2.toFixed(3)}, ${ah2.toFixed(3)}]  (0.5 = no ranking)`);
  const sorted=[...rows].sort((x,y)=>x.c-y.c); const t=Math.floor(sorted.length/3);
  const bot=sorted.slice(0,t), top=sorted.slice(sorted.length-t);
  const [tl,th]=bootstrap(top, s=>mean(s.map(x=>x.r))); const [btl,bth]=bootstrap(bot, s=>mean(s.map(x=>x.r)));
  console.log(`  top tercile (conv≥${top[0].c.toFixed(2)}) mean return ${mean(top.map(x=>x.r)).toFixed(2)}%  boot95 [${tl.toFixed(2)}, ${th.toFixed(2)}]`);
  console.log(`  bot tercile (conv≤${bot.at(-1).c.toFixed(2)}) mean return ${mean(bot.map(x=>x.r)).toFixed(2)}%  boot95 [${btl.toFixed(2)}, ${bth.toFixed(2)}]`);
  const pl=platt(rows);
  console.log(`  Platt DIAGNOSTIC (not shipped): slope(scaled)=${pl.b_scaled.toFixed(3)}  P(win) at conv 0.50/0.66/0.73 = ${(pl.predAtRaw(0.5)*100).toFixed(0)}% / ${(pl.predAtRaw(0.66)*100).toFixed(0)}% / ${(pl.predAtRaw(0.73)*100).toFixed(0)}%`);
  console.log(`    → prediction spread ${((pl.predAtRaw(0.8)-pl.predAtRaw(0.4))*100).toFixed(1)} pts across conv 0.40→0.80 (near 0 = collapses to base rate = resolution≈0)`);
}

report("ALL-TIME", rowsAll);
report("JUNE-2026+", rowsAll.filter(x=>x.t>=JUNE));
process.exit(0);
