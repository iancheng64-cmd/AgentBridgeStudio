import { useEffect, useState } from 'react';
import { Glyph } from './StudioUI';

export function AttachmentVisual({ file, large = false }: { file: { id: string; name: string; mimeType?: string }; large?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  const isImage = file.mimeType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (isImage && window.agentBridge?.library.preview) {
      window.agentBridge.library.preview(file.id).then(value => { if (active) setPreview(value); }).catch(() => {});
    }
    return () => { active = false; };
  }, [file.id, isImage]);
  return preview ? <img className={`attachment-thumbnail ${large ? 'large' : ''}`} src={preview} alt={file.name} /> : <Glyph name="file" size={large ? 32 : 20} />;
}
