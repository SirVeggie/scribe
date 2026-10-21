import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
const key=folder=>process.platform==="win32"?folder.toLowerCase():folder;
function repositories(ctx){return [...new Map((ctx.settings.repositories??[]).filter(folder=>typeof folder==="string"&&path.isAbsolute(folder)).map(folder=>{const resolved=fs.realpathSync(folder);return [key(resolved),resolved];})).values()];}
export default {
  methods:{
    repositories:(_args,ctx)=>({repositories:repositories(ctx)}),
    log:async(args,ctx)=>{
      if(typeof args.repository!=="string"||!path.isAbsolute(args.repository))throw new Error("Choose an approved repository");
      const repository=fs.realpathSync(args.repository);
      if(!repositories(ctx).some(folder=>key(folder)===key(repository)))throw new Error("Repository is not approved; ask to add it from the page");
      const limit=Math.max(1,Math.min(2000,Number.isFinite(args.limit)?Math.floor(args.limit):500));
      const since=typeof args.since==="string"?args.since:"90 days ago";
      if(since.length>100)throw new Error("Since value is too long");
      const {stdout}=await execute("git",["--no-pager","-c","core.quotepath=false","log",`--max-count=${limit}`,`--since=${since}`,"--date=iso-strict","--format=%H%x00%an%x00%ae%x00%aI%x00%s%x1e","--"],{cwd:repository,windowsHide:true,timeout:30_000,maxBuffer:8*1024**2,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}});
      const commits=stdout.split("\x1e").map(record=>record.trim()).filter(Boolean).map(record=>{const [hash,author,email,date,subject]=record.split("\0");return {hash,author,email,date,subject};});
      return {repository,commits,queriedAt:Date.now()};
    }
  }
};
