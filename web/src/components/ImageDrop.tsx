import { useRef, useState } from 'react';

/**
 * File picker with drag-and-drop.
 *
 * Drag-and-drop is offered but never required — it is an accelerator for Jenny,
 * not a gate for Dave. The visible button is a real <input type="file">, which
 * means it is keyboard reachable and works with screen readers for free.
 */
export function ImageDrop({
  onFiles,
  multiple = false,
  accept = 'image/*',
  label,
  hint,
  children,
}: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  accept?: string;
  label: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files).filter((f) =>
      accept === 'image/*' ? f.type.startsWith('image/') : true,
    );
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      className={`dropzone${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {children}
      {hint && <p>{hint}</p>}
      <input
        ref={inputRef}
        id={`file-${label.replace(/\s+/g, '-').toLowerCase()}`}
        type="file"
        accept={accept}
        multiple={multiple}
        className="visually-hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          // Reset so re-picking the same file still fires a change event.
          e.target.value = '';
        }}
      />
      <button type="button" className="btn btn-secondary" onClick={() => inputRef.current?.click()}>
        {label}
      </button>
    </div>
  );
}
