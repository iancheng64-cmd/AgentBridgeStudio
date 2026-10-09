#!/usr/bin/env python3
"""Build-time downloads only; verify pinned upstream SHA256 before packaging."""
import argparse,hashlib,json,os,shutil,subprocess,tarfile,tempfile,zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
NODE='22.23.3';CF='2026.10.0'
ASSETS={
 'windows-x64':[(f'https://nodejs.org/dist/v{NODE}/node-v{NODE}-win-x64.zip','2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71','node.zip'),(f'https://github.com/cloudflare/cloudflared/releases/download/{CF}/cloudflared-windows-amd64.exe','86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c','cloudflared.exe')],
 'macos-arm64':[(f'https://nodejs.org/dist/v{NODE}/node-v{NODE}-darwin-arm64.tar.gz','23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53','node.tgz'),(f'https://github.com/cloudflare/cloudflared/releases/download/{CF}/cloudflared-darwin-arm64.tgz','a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70','cloudflared.tgz')]}
def download(task):
 url,digest,target=task
 subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2','--max-time','240',url,'-o',str(target)],check=True)
 if hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise ValueError('Upstream checksum mismatch: '+target.name)
def build(output):
 version=json.loads((ROOT/'package.json').read_text())['version'];output.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='agentbridge-gateway-package-')as tmp:
  tmp=Path(tmp);tasks=[]
  for platform,assets in ASSETS.items():
   (tmp/platform).mkdir()
   tasks.extend((url,digest,tmp/platform/name)for url,digest,name in assets)
  with ThreadPoolExecutor(max_workers=4)as pool:list(pool.map(download,tasks))
  for platform,assets in ASSETS.items():
   cached=tmp/platform;stage=cached/'AgentBridgeGateway';stage.mkdir()
   for name in ['gateway.cjs','package.json','config.example.json','README.md']:shutil.copy2(ROOT/'gateway'/name,stage/name)
   shutil.copy2(ROOT/'LICENSE',stage/'LICENSE')
   shutil.copytree(ROOT/'node_modules/ws',stage/'node_modules/ws',ignore=shutil.ignore_patterns('node_modules','.github'))
   (stage/'THIRD_PARTY.md').write_text(f'Node.js {NODE}: https://github.com/nodejs/node (license bundled).\nws 8.22.0: https://github.com/websockets/ws (MIT; license bundled).\ncloudflared {CF}: https://github.com/cloudflare/cloudflared (Apache-2.0; license bundled).\n')
   subprocess.run(['curl','--fail','--location','--silent','--show-error',f'https://raw.githubusercontent.com/cloudflare/cloudflared/{CF}/LICENSE','-o',str(stage/'CLOUDFLARED_LICENSE')],check=True)
   for doc in ['RELAY.md','CLOUDFLARE_TUNNEL.md','NETWORK_DIAGNOSTICS.md']:shutil.copy2(ROOT/'docs/networking'/doc,stage/doc)
   if platform=='windows-x64':
    with zipfile.ZipFile(cached/'node.zip')as archive:
     for original,target in [(f'node-v{NODE}-win-x64/node.exe','node.exe'),(f'node-v{NODE}-win-x64/LICENSE','NODE_LICENSE')]: (stage/target).write_bytes(archive.read(original))
    shutil.copy2(cached/'cloudflared.exe',stage/'cloudflared.exe')
    for name,command in {'StartGateway':'node.exe gateway.cjs','Pair':'node.exe gateway.cjs --pair','StartTunnel':'cloudflared.exe tunnel --config "%USERPROFILE%\\.cloudflared\\config.yml" run','QuickTunnel':'cloudflared.exe tunnel --url http://127.0.0.1:8787'}.items():(stage/(name+'.cmd')).write_text('@echo off\nchcp 65001 >nul\ncd /d "%~dp0"\n'+command+'\npause\n',encoding='utf8')
    (stage/'Install.cmd').write_text('@echo off\nsetlocal\nset "target=%LOCALAPPDATA%\\AgentBridgeGateway"\nrobocopy "%~dp0." "%target%" /E /XF Install.cmd >nul\nif errorlevel 8 (echo Installation failed & pause & exit /b 1)\nstart "" "%target%\\StartGateway.cmd"\n',encoding='utf8')
   else:
    with tarfile.open(cached/'node.tgz')as archive:
     for original,target in [(f'node-v{NODE}-darwin-arm64/bin/node','node'),(f'node-v{NODE}-darwin-arm64/LICENSE','NODE_LICENSE')]: (stage/target).write_bytes(archive.extractfile(original).read())
    with tarfile.open(cached/'cloudflared.tgz')as archive:
     members=[m for m in archive.getmembers()if Path(m.name).name=='cloudflared' and m.isfile()]
     if len(members)!=1:raise ValueError('Unexpected cloudflared archive')
     (stage/'cloudflared').write_bytes(archive.extractfile(members[0]).read())
    for name,command in {'StartGateway':'./node gateway.cjs','Pair':'./node gateway.cjs --pair','StartTunnel':'./cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run','QuickTunnel':'./cloudflared tunnel --url http://127.0.0.1:8787'}.items():
     file=stage/(name+'.command');file.write_text('#!/bin/zsh\ncd -- "${0:A:h}"\n'+command+'\nread -r "reply?按 Enter 關閉"\n');file.chmod(0o755)
    for name in ['node','cloudflared']:(stage/name).chmod(0o755)
   manifest={f.relative_to(stage).as_posix():{'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}for f in stage.rglob('*')if f.is_file()}
   (stage/'PACKAGE_MANIFEST.json').write_text(json.dumps({'version':version,'platform':platform,'upstream':assets,'files':manifest},indent=2)+'\n')
   file=output/f'AgentBridge-Gateway-{version}-{platform}.zip'
   with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED)as archive:
    for source in sorted(stage.rglob('*')):
     if source.is_file():archive.write(source,'AgentBridgeGateway/'+source.relative_to(stage).as_posix())
   with zipfile.ZipFile(file)as archive:assert archive.testzip()is None
   file.with_suffix('.zip.sha256').write_text(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n');print(file)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=ROOT/'dist');build(p.parse_args().output)
