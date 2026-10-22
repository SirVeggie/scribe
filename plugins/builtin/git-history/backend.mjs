import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
const key=folder=>process.platform==="win32"?folder.toLowerCase():folder;
function repositories(ctx){const found=new Map();for(const folder of ctx.settings.repositories??[]){if(typeof folder!=="string"||!path.isAbsolute(folder))continue;try{const resolved=fs.realpathSync(folder);found.set(key(resolved),resolved);}catch{}}return [...found.values()];}
function approvedRepository(args,ctx){
  if(typeof args.repository!=="string"||!path.isAbsolute(args.repository))throw new Error("Choose an approved repository");
  const repository=fs.realpathSync(args.repository);
  if(!repositories(ctx).some(folder=>key(folder)===key(repository)))throw new Error("Repository is not approved; ask to add it from the page");
  return repository;
}
export default {
  methods:{
    repositories:(_args,ctx)=>({repositories:repositories(ctx)}),
    activity:async(args,ctx)=>{
      const repository=approvedRepository(args,ctx);
      const options={cwd:repository,windowsHide:true,timeout:30_000,maxBuffer:32*1024**2,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}};
      const [history,head]=await Promise.all([
        execute("git",["--no-pager","log","--date=format:%Y-%m-%d","--format=%ad","--"],options),
        execute("git",["rev-parse","--abbrev-ref","HEAD"],options)
      ]);
      const days={};let total=0;
      for(const day of history.stdout.split(/\r?\n/))if(/^\d{4}-\d{2}-\d{2}$/.test(day)){days[day]=(days[day]??0)+1;total++;}
      return {repository,branch:head.stdout.trim(),days,total,queriedAt:Date.now()};
    },
    log:async(args,ctx)=>{
      const repository=approvedRepository(args,ctx);
      const limit=Math.max(1,Math.min(2000,Number.isFinite(args.limit)?Math.floor(args.limit):500));
      const since=typeof args.since==="string"?args.since:"90 days ago";
      if(since.length>100)throw new Error("Since value is too long");
      const {stdout}=await execute("git",["--no-pager","-c","core.quotepath=false","log",`--max-count=${limit}`,`--since=${since}`,"--date=iso-strict","--format=%H%x00%an%x00%ae%x00%aI%x00%s%x1e","--"],{cwd:repository,windowsHide:true,timeout:30_000,maxBuffer:8*1024**2,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}});
      const commits=stdout.split("\x1e").map(record=>record.trim()).filter(Boolean).map(record=>{const [hash,author,email,date,subject]=record.split("\0");return {hash,author,email,date,subject};});
      return {repository,commits,queriedAt:Date.now()};
    }
  }
};
