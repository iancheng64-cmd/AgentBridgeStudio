import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { SPRINGS } from './motion';
import {inlineTokens,textPages} from '../main/chat-performance';

export function Glyph({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string,string> = {
    panel:'M3 4h18v16H3zM9 4v16', new:'M13.5 4.5l6 6M5 19l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L5 19z',
    search:'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', library:'M4 4v16M8 4v16M13 5l5-1 3 15-5 1z',
    apps:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', folder:'M3 6h6l2 2h10v12H3z',
    chat:'M4 4h16v13H9l-5 4V4z', settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z',
    plus:'M12 5v14M5 12h14', down:'M7 10l5 5 5-5', up:'M12 19V5M6 11l6-6 6 6', close:'M6 6l12 12M18 6L6 18',
    bolt:'M13 2L4 14h7l-1 8 10-13h-7l1-7z', computer:'M3 4h18v13H3zM8 21h8M12 17v4', terminal:'M5 6l6 6-6 6M13 18h6',
    file:'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6', upload:'M12 16V3M7 8l5-5 5 5M4 16v5h16v-5',
    link:'M9 15l6-6M8 16l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16 8l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0',
    more:'M5 12h.01M12 12h.01M19 12h.01', trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
    check:'M5 12l4 4L19 6', copy:'M9 9h12v12H9zM15 6V3H3v12h3', refresh:'M20 5v6h-6M20 11A8 8 0 1 0 19 17',
    moon:'M20 15A8 8 0 0 1 9 4a8.5 8.5 0 1 0 11 11z', sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
    history:'M3 5v6h6M3 11a9 9 0 1 1 2 7M12 7v6l4 2', globe:'M3 12h18M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
    pin:'M9 3h6l-1 6 4 4v2h-5v7h-2v-7H6v-2l4-4-1-6z', archive:'M3 3h18v5H3zM5 8v13h14V8M10 12h4',
    shield:'M12 3l8 3v6c0 5-8 10-8 10s-8-5-8-10V6l8-3zM8 12l3 3 5-6', export:'M12 15V3M7 8l5-5 5 5M4 13v8h16v-8',
    stop:'M6 6h12v12H6z', arrow:'M5 12h14M13 6l6 6-6 6', mic:'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0V4zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    spark:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z', code:'M8 6l-6 6 6 6M16 6l6 6-6 6M14 3l-4 18', info:'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.spark}/></svg>;
}

export function Modal({ title, children, close, className = '' }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  // The caller unmounts the modal the moment it decides to close. Keep it alive
  // until the exit has actually played, so a dismissal reads as a sheet
  // travelling back out rather than the panel blinking out of existence.
  // A ref, not state: the keydown handler below closes over the first render and
  // must not read a stale `leaving` value.
  const leavingRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const requestClose = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    window.setTimeout(() => closeRef.current(), 195);
  };
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const frame = requestAnimationFrame(() => ((panel?.querySelector('input,textarea') || panel?.querySelector('button')) as HTMLElement | null)?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); requestClose(); }
      if (event.key === 'Tab' && panel) {
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"]')).filter(el=>el.offsetParent!==null);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown',key);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown',key); prior?.focus(); };
  },[]);
  // Blur radius and scale animate together, so a glass surface reads as a
  // material arriving rather than as a plain opacity fade. The exit retraces
  // the same path it entered on, mirrored in time.
  return (
    <motion.div
      className="modal-backdrop"
      data-leaving={leaving ? 'true' : undefined}
      onMouseDown={e=>e.target===e.currentTarget&&requestClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: leaving ? 0 : 1 }}
      transition={{ duration: leaving ? 0.16 : 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <motion.div
        className={`modal-panel ${className}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ opacity: 0, scale: 0.97, y: 10, filter: 'blur(14px)' }}
        animate={{ opacity: leaving ? 0 : 1, scale: leaving ? 0.975 : 1, y: leaving ? 6 : 0, filter: leaving ? 'blur(10px)' : 'blur(0px)' }}
        transition={leaving ? { ...SPRINGS.snappy, duration: 0.19 } : { ...SPRINGS.soft, duration: 0.42 }}
      >
        <div className="modal-heading"><h2>{title}</h2><button className="icon-btn" title="關閉（Esc）" aria-label="關閉" onClick={requestClose}><Glyph name="close"/></button></div>{children}
      </motion.div>
    </motion.div>
  );
}

function inlineText(text:string):ReactNode[] {
  return inlineTokens(text).map((part,i)=>{
    if(part.type==='link')return <a key={i} href={part.href} onClick={event=>{event.preventDefault();void window.agentBridge.system.openExternal(part.href!);}}>{part.text}</a>;
    if(part.type==='bold')return <strong key={i}>{part.text}</strong>;
    if(part.type==='code')return <code key={i}>{part.text}</code>;
    return part.text;
  });
}
function CodeBlock({text}:{text:string}) {
  const [copied,setCopied]=useState(false);
  const [copyError,setCopyError]=useState(false);
  const content=text.slice(3).replace(/```$/,''); const line=content.indexOf('\n');
  const code=line>=0?content.slice(line+1):content;
  return <div className="code-block"><div className="code-heading"><span>{line>=0?content.slice(0,line)||'code':'code'}</span><button onClick={()=>{navigator.clipboard.writeText(code).then(()=>{setCopied(true);setCopyError(false);setTimeout(()=>setCopied(false),2000);},()=>setCopyError(true));}}><Glyph name={copied?'check':'copy'} size={13}/>{copyError?'複製失敗，請選取文字':copied?'已複製':'複製程式碼'}</button></div><pre><code>{code}</code></pre></div>;
}
function prose(text:string):ReactNode[] {
  const lines=text.split('\n'); const result:ReactNode[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(!line.trim()){result.push(<div className="paragraph-gap" key={i}/>);continue;}
    if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
      const cells=(value:string)=>value.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim());
      const headers=cells(line);const rows:string[][]=[];const key=i;i+=2;
      while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){rows.push(cells(lines[i]));i++;}i--;
      result.push(<div className="markdown-table" key={key}><table><thead><tr>{headers.map((cell,k)=><th key={k}>{inlineText(cell)}</th>)}</tr></thead><tbody>{rows.map((row,j)=><tr key={j}>{row.map((cell,k)=><td key={k}>{inlineText(cell)}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    const title=line.match(/^(#{1,6})\s+(.*)/);if(title){result.push(<h3 key={i}>{inlineText(title[2])}</h3>);continue;}
    const list=line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.*)/);
    if(list){const ordered=!!list[2];const key=i;const items:string[]=[];while(i<lines.length){const match=lines[i].match(/^\s*(?:([-*+])|(\d+)\.)\s+(.*)/);if(!match||!!match[2]!==ordered)break;items.push(match[3]);i++;}i--;const children=items.map((item,j)=><li key={j}>{inlineText(item)}</li>);result.push(ordered?<ol key={key}>{children}</ol>:<ul key={key}>{children}</ul>);continue;}
    if(/^>\s?/.test(line)){result.push(<blockquote key={i}>{inlineText(line.replace(/^>\s?/,''))}</blockquote>);continue;}
    if(/^(-{3,}|\*{3,})\s*$/.test(line)){result.push(<hr key={i}/>);continue;}
    result.push(<p key={i}>{inlineText(line)}</p>);
  }
  return result;
}
export const MessageBody = memo(function MessageBody({ text, streaming=false }: { text: string; streaming?:boolean }) {
  const boundaries=useMemo(()=>textPages(text),[text]);
  const [selected,setSelected]=useState<number|null>(null);const streamed=useRef(false);if(streaming)streamed.current=true;
  const pages=Math.max(1,boundaries.length-1),page=Math.min(selected??(streamed.current?pages-1:0),pages-1);
  if(pages>1)return <div className="message-body long-message"><div className="text-page-controls"><span>第 {page+1} / {pages} 段</span><button disabled={page===0} onClick={()=>setSelected(page-1)}>上一段</button><button disabled={page===pages-1} onClick={()=>setSelected(page+1)}>下一段</button></div><pre className="long-message-text">{text.slice(boundaries[page],boundaries[page+1])}</pre></div>;
  return <div className="message-body">{text.split(/(```[\s\S]*?(?:```|$))/g).map((block,i)=>block.startsWith('```')?<CodeBlock key={i} text={block}/>:<div key={i}>{prose(block)}</div>)}</div>;
});
