import path from "node:path";
import { findRepo, git } from "../agent/git.js";
/** Fold temporary worktrees into the main repository kept by Git. */
export async function mainRepository(folder:string):Promise<string|null>{
  const repo=await findRepo(folder);if(!repo)return null;
  const result=await git(["rev-parse","--path-format=absolute","--git-common-dir"],repo,{timeoutMs:5000});
  if(result.code!==0)return repo;
  const common=path.normalize(result.stdout.trim());return path.basename(common)===".git"?path.dirname(common):repo;
}
