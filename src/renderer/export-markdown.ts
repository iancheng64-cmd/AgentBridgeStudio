/* Pure serializer: one conversation -> GitHub-flavoured Markdown.
 * Kept dependency-free so it compiles and runs standalone under Node for tests. */

export interface ExportAttachment { name: string }
export interface ExportToolActivity { title: string; status?: 'running' | 'completed' | 'error'; durationMs?: number }
export interface ExportMessage {
  role: 'user' | 'assistant';
  text: string;
  status?: 'running' | 'completed' | 'cancelled' | 'error';
  attachments?: ExportAttachment[];
  tools?: ExportToolActivity[];
}
export interface ExportChat {
  title: string;
  agent?: string;
  messages: ExportMessage[];
  updatedAt?: number;
}

const STATUS_LABEL: Record<NonNullable<ExportMessage['status']>, string> = {
  running: '進行中',
  completed: '完成',
  cancelled: '已停止',
  error: '錯誤',
};

export const chatToMarkdown = (chat: ExportChat): string => {
  const stamp = chat.updatedAt === undefined ? new Date() : new Date(chat.updatedAt);
  const lines: string[] = [
    `# ${chat.title}`,
    '',
    `> Agent：${chat.agent === 'claude' ? 'Claude Code' : 'Codex'} · 匯出時間：${new Date().toLocaleString()} · ${chat.messages.length} 則訊息`,
    '',
  ];
  for (const message of chat.messages) {
    lines.push(`## ${message.role === 'user' ? '使用者' : 'Agent'}`);
    const status = message.status ? ` · ${STATUS_LABEL[message.status]}` : '';
    lines.push(`*${stamp.toLocaleString()}${status}*`, '');
    if (message.text.trim()) lines.push(message.text.trim());
    if (message.attachments?.length) lines.push('', `**附件：** ${message.attachments.map(file => file.name).join('、')}`);
    if (message.tools?.length) {
      lines.push('');
      for (const tool of message.tools) {
        const toolStatus = tool.status === 'completed' ? '完成' : tool.status === 'error' ? '錯誤' : '未完成';
        const seconds = tool.durationMs === undefined ? '' : ` · ${(tool.durationMs / 1000).toFixed(1)} 秒`;
        lines.push(`- ${tool.title}（${toolStatus}${seconds}）`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
};

/* Matches the filesystem-safe rule used by exportMarkdown in App.tsx. */
export const sanitizeFilename = (title: string): string =>
  title.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 60) || '對話';
