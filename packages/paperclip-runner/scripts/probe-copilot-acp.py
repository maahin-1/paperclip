"""Run the pinned real Copilot binary against a deterministic loopback model.
No credentials are inherited; COPILOT_OFFLINE disables provider network access.
This proves a protocol fixture, never GitHub/model/Daytona qualification.
"""
import argparse,json,subprocess,tempfile,pathlib,os,select,time,threading,http.server,hashlib,shutil
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--package-root',required=True)
parser.add_argument('--scenario',choices=['deny-write','attached-shell'],default='deny-write')
args=parser.parse_args()
package_root=pathlib.Path(args.package_root).resolve()
metadata=json.loads((package_root/'package.json').read_text())
pins={'@github/copilot-darwin-arm64':'a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3','@github/copilot-darwin-x64':'85eb919f6b9b9dd833ce5e326cbf974b3ee2d4a9ac525c59d4ec9c9ec085715b','@github/copilot-linux-x64':'0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748'}
assert metadata['version']=='1.0.88' and metadata['name'] in pins
assert not (package_root/'copilot').is_symlink()
assert hashlib.sha256((package_root/'copilot').read_bytes()).hexdigest()==pins[metadata['name']]
model_tool_names=[]
command='sleep 2; printf ACP_SHELL_DONE > settlement.txt'

binary=str(package_root/'copilot')
root=pathlib.Path(tempfile.mkdtemp(prefix='paperclip-copilot-offline-'))
calls=0
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'data':[{'id':'gpt-4.1','object':'model','owned_by':'fixture'}]}).encode())
 def do_POST(self):
  global calls,model_tool_names
  calls+=1
  data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
  model_tool_names=[x.get('function',{}).get('name') for x in data.get('tools',[])]
  if calls>4:raise RuntimeError('Fixture model exceeded its bounded request count')
  if data.get('stream'):
   self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
   values=[{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','content':'Fixture complete.'},'finish_reason':None}]},{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':3,'total_tokens':13}}]
   if calls==1:values=[{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','tool_calls':[{'index':0,'id':'fixture-tool','type':'function','function':{'name':'create' if args.scenario=='deny-write' else 'bash','arguments':json.dumps({'path':str(root/'denied.txt'),'file_text':'MUST NOT EXIST'} if args.scenario=='deny-write' else {'command':command,'description':'Bounded settlement fixture','mode':'async','detach':False})}}]},'finish_reason':None}]},{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]}]
   for value in values:self.wfile.write(('data: '+json.dumps(value)+'\n\n').encode())
   self.wfile.write(b'data: [DONE]\n\n')
  else:
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':'fixture-1','object':'chat.completion','choices':[{'index':0,'message':{'role':'assistant','content':'Fixture complete.'},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':3,'total_tokens':13}}).encode())
server=http.server.HTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
env={'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'XDG_CONFIG_HOME':str(root/'config'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_DATA_HOME':str(root/'data'),'COPILOT_HOME':str(root/'copilot'),'COPILOT_CACHE_HOME':str(root/'copilot-cache'),'COPILOT_AUTO_UPDATE':'false','COPILOT_OFFLINE':'true','COPILOT_PROVIDER_BASE_URL':f'http://127.0.0.1:{server.server_port}','COPILOT_PROVIDER_TYPE':'openai','COPILOT_PROVIDER_MODEL_ID':'gpt-4.1','COPILOT_MODEL':'gpt-4.1','NO_COLOR':'1'}
for key in ('HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','COPILOT_HOME','COPILOT_CACHE_HOME'):pathlib.Path(env[key]).mkdir()
(root/'copilot/config.json').write_text(json.dumps({'trustedFolders':[],'disableAllHooks':True,'memory':False,'ide':{'autoConnect':False}}))
p=subprocess.Popen([binary,'--acp','--stdio','--no-auto-update','--disable-builtin-mcps','--no-remote','--no-remote-export','--no-bash-env'],env=env,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
responses={};wire=[];permission_responses=[];buf={p.stdout:b'',p.stderr:b''};nextid=0;marker_at_prompt_result=False

def pump(wait=1):
 for stream in select.select([p.stdout,p.stderr],[],[],wait)[0]:
  data=os.read(stream.fileno(),65536)
  if not data:continue
  buf[stream]+=data
  while b'\n' in buf[stream]:
   line,buf[stream]=buf[stream].split(b'\n',1)
   if not line:continue
   if stream==p.stderr:continue
   message=json.loads(line);wire.append(message)
   if 'id' in message and 'method' not in message:responses[message['id']]=message
   if message.get('method')=='session/request_permission':
    allow=args.scenario=='attached-shell' and message['params'].get('toolCall',{}).get('rawInput',{}).get('command')==command
    reject=next((o for o in message['params']['options'] if o['kind']==('allow_once' if allow else 'reject_once')),None)
    outcome={'outcome':'selected','optionId':reject['optionId']} if reject else {'outcome':'cancelled'}
    permission_responses.append({'id':message['id'],'outcome':outcome})
    p.stdin.write((json.dumps({'jsonrpc':'2.0','id':message['id'],'result':{'outcome':outcome}})+'\n').encode());p.stdin.flush()

def request(method,params):
 global nextid
 nextid+=1;n=nextid;p.stdin.write((json.dumps({'jsonrpc':'2.0','id':n,'method':method,'params':params})+'\n').encode());p.stdin.flush();deadline=time.monotonic()+30
 while n not in responses and time.monotonic()<deadline:pump()
 if n not in responses:raise TimeoutError(method)
 return responses[n]
try:
 request('initialize',{'protocolVersion':1,'clientCapabilities':{'_meta':{'github.com/copilot':{'events':['session.idle','session.plan_changed','session.background_tasks_changed','session.completion_receipt','user_input.requested','exit_plan_mode.requested','assistant.usage']}}},'clientInfo':{'name':'paperclip-offline-fixture','version':'1'}})
 session=request('session/new',{'cwd':str(root),'mcpServers':[]})
 if 'result' in session:
  request('session/prompt',{'sessionId':session['result']['sessionId'],'prompt':[{'type':'text','text':'Reply with Fixture complete.'}]})
  marker_at_prompt_result=(root/('denied.txt' if args.scenario=='deny-write' else 'settlement.txt')).exists()
  for _ in range(3):pump(.1)
finally:
 marker_exists=(root/('denied.txt' if args.scenario=='deny-write' else 'settlement.txt')).exists()
 report={'schema':'paperclip.copilot-acp-evidence/v1','harnessVersion':'1.0.88','package':metadata['name'],'executableSha256':pins[metadata['name']],'modelSource':'deterministic loopback fixture, COPILOT_OFFLINE=true; not a live model qualification','scenario':args.scenario,'costUsd':0,'filesystemMarkerExistedAtPromptResult':marker_at_prompt_result,'filesystemMarkerExistedAfterPrompt':marker_exists,'modelCalls':calls,'modelToolNames':model_tool_names,'permissionResponses':permission_responses,'wire':wire}
 serialized=json.dumps(report,indent=2).replace(str(root),'/fixture/workspace').replace(str(root).lstrip('/'),'fixture/workspace').replace(binary,'/fixture/verified/copilot')
 print(serialized)

 p.stdin.close();p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
 server.shutdown();shutil.rmtree(root)
 if 'result' not in session or responses.get(3,{}).get('result',{}).get('stopReason')!='end_turn':
  raise RuntimeError('Copilot did not complete the fixture turn')
 if marker_at_prompt_result != (args.scenario=='attached-shell') or marker_exists != marker_at_prompt_result:
  raise RuntimeError('Copilot violated the fixture filesystem expectation')
