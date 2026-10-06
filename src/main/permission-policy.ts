export type PermissionMode='ask'|'project'|'full';
export function permissionMode(value:unknown):PermissionMode {
  if(value!=='ask'&&value!=='project'&&value!=='full')throw new Error('請選擇有效的操作權限。');
  return value;
}
export function codexPermissionPolicy(mode:PermissionMode){return mode==='full'?{approvalPolicy:'never',sandbox:'danger-full-access'}:{approvalPolicy:'untrusted',sandbox:'read-only'};}
