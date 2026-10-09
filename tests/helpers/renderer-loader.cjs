// Compile the actual renderer component with the same bundler family as Vite.
const path=require('node:path'),Module=require('node:module');
exports.load=async relative=>{
 const {rolldown}=await import('rolldown');const file=path.join(__dirname,'../../src/renderer',relative);
 const build=await rolldown({input:file,external:id=>!id.startsWith('.')&&!path.isAbsolute(id),transform:{jsx:{runtime:'automatic'}}});
 try{const result=await build.generate({format:'cjs'});const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(result.output.find(item=>item.type==='chunk').code,file);return mod.exports;}finally{await build.close();}
};
