/* Pure chat helpers: branching conversations and in-conversation search.
 * Kept dependency-free so they run under plain Node for tests. */

export interface SearchableMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: { title: string }[];
}
export interface SearchableChat {
  id: string;
  title: string;
  messages: SearchableMessage[];
}

export interface ConversationHit {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: 'user' | 'assistant';
  /** Character offset of the first match within `excerpt`, 0-based. */
  excerpt: string;
  matchStart: number;
  matchLength: number;
  toolTitles: string[];
}

export const EXCERPT_RADIUS = 90;
export const MAX_HITS = 200;

/** Case-insensitive substring search across one chat's messages and tool titles.
 * ponytail: O(messages × length) substring scan — fine for chat-sized data;
 * if conversations ever reach book length, switch to a prebuilt index. */
export function findInConversation(chat: SearchableChat, query: string): ConversationHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: ConversationHit[] = [];
  for (const message of chat.messages) {
    const toolTitles = (message.tools ?? []).map(tool => tool.title);
    const haystacks: string[] = [message.text, ...toolTitles];
    for (const haystack of haystacks) {
      const lower = haystack.toLowerCase();
      let index = lower.indexOf(needle);
      while (index !== -1) {
        const start = Math.max(0, index - EXCERPT_RADIUS);
        const end = Math.min(haystack.length, index + needle.length + EXCERPT_RADIUS);
        const excerpt = (start > 0 ? '…' : '') + haystack.slice(start, end) + (end < haystack.length ? '…' : '');
        hits.push({
          chatId: chat.id,
          chatTitle: chat.title,
          messageId: message.id,
          role: message.role,
          excerpt,
          matchStart: index - start + (start > 0 ? 1 : 0),
          matchLength: needle.length,
          toolTitles: haystack === message.text ? [] : toolTitles,
        });
        if (hits.length >= MAX_HITS) return hits;
        index = lower.indexOf(needle, index + 1);
      }
    }
  }
  return hits;
}

export const BRANCH_LABEL = '分支';

/** Deep-copy a chat, keeping messages up to and including the anchor message.
 * The branch is a fresh conversation: same context window, new future. */
export function branchChat<T extends { id: string; title: string; messages: unknown[] }>(
  chat: T,
  anchorMessageId: string,
  makeId: () => string,
  now: number,
): T | null {
  const index = chat.messages.findIndex(message => (message as { id?: string }).id === anchorMessageId);
  if (index === -1) return null;
  return {
    ...chat,
    id: makeId(),
    title: `${chat.title}（${BRANCH_LABEL}）`.slice(0, 100),
    messages: JSON.parse(JSON.stringify(chat.messages.slice(0, index + 1))) as unknown[],
    createdAt: now,
    updatedAt: now,
    remoteId: undefined,
    executorEnvironmentId: undefined,
    recoveryNeeded: true,
  } as T;
}
