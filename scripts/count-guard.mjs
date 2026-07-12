import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const ROOTS = ["src/components", "src/app"];
const ALLOW = ["src/components/ui/"];
function walk(d, o = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, o);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) o.push(p);
  }
  return o;
}
function count(re) {
  let n = 0;
  for (const r of ROOTS)
    for (const f of walk(r)) {
      if (ALLOW.some((a) => f.replace(/\\/g, "/").includes(a))) continue;
      n += (readFileSync(f, "utf8").match(re) ?? []).length;
    }
  return n;
}
console.log("toFixed:", count(/\.toFixed\(/g));
console.log("toLocaleString:", count(/toLocaleString\(/g));
console.log("addrSlice:", count(/slice\(0, ?[0-9]+\)[^;\n]{0,24}slice\(-[0-9]+\)/g));
