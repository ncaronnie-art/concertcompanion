import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {withTemporaryCleanup} from "./temporary-cleanup.js";

/** Keep generated filter graphs off Windows' limited process command line.
 * The callback must await FFmpeg's actual process/stdio close, including on
 * cancellation, before settling. Files remain alive for that entire callback.
 * Cleanup is best effort and cannot replace the callback's value or error. */
export async function withRenderGraphFile<T>(args:string[],work:(args:string[])=>Promise<T>):Promise<T>{
 const graphs:{index:number;value:string}[]=[];
 for(let index=0;index<args.length;index++){
  if(args[index]!=="-filter_complex")continue;
  if(typeof args[index+1]!=="string"||!args[index+1].length)throw Error("The video render graph is missing.");
  graphs.push({index,value:args[index+1]});index++;
 }
 if(!graphs.length)return work([...args]);
 const temporaryRoot=path.resolve(tmpdir()),directory=await mkdtemp(path.join(temporaryRoot,"vibe-render-graph-"));
 // The recursive cleanup target is generated locally, never supplied by media
 // or project input. Confirm its exact parent before allowing cleanup.
 if(path.dirname(path.resolve(directory))!==temporaryRoot)throw Error("Cannot create a local video render workspace.");
 const result=await withTemporaryCleanup(directory,async()=>{
  const planned=[...args];
  for(const [number,graph] of graphs.entries()){
   const file=path.join(directory,`filter-${number}.ffscript`);
   await writeFile(file,graph.value,{encoding:"utf8",flag:"wx"});
   planned[graph.index]="-filter_complex_script";planned[graph.index+1]=file;
  }
  return work(planned);
 });
 return result.value;
}
