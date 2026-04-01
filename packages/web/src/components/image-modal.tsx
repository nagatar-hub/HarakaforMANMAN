'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ImageItem = {
  id: string;
  franchise: string;
  page_label: string | null;
  image_url: string | null;
  card_ids: string[];
};

type Props = {
  images: ImageItem[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
};

export function ImageModal({ images, currentIndex, onClose, onNavigate }: Props) {
  const current = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset zoom on image change
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [currentIndex]);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onNavigate(currentIndex - 1);
      if (e.key === 'ArrowRight' && hasNext) onNavigate(currentIndex + 1);
      if (e.key === '0') {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
      }
    },
    [onClose, onNavigate, currentIndex, hasPrev, hasNext],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [handleKey]);

  // Ctrl+wheel zoom — zoom toward mouse cursor
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();

      const img = imgRef.current;
      if (!img) return;

      const rect = img.getBoundingClientRect();
      // Mouse position relative to viewport center of the image
      const imgCenterX = rect.left + rect.width / 2;
      const imgCenterY = rect.top + rect.height / 2;
      const mouseOffsetX = e.clientX - imgCenterX;
      const mouseOffsetY = e.clientY - imgCenterY;

      const oldScale = scale;
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      const newScale = Math.min(Math.max(oldScale + delta, 0.5), 5);

      if (newScale === oldScale) return;

      // Adjust translation so the point under cursor stays put
      const factor = newScale / oldScale;
      const newX = translate.x * factor + mouseOffsetX * (1 - factor);
      const newY = translate.y * factor + mouseOffsetY * (1 - factor);

      setScale(newScale);
      setTranslate({ x: newX, y: newY });
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [scale, translate]);

  // Drag to pan when zoomed
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
      translateStart.current = { ...translate };
    },
    [scale, translate],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setTranslate({
        x: translateStart.current.x + dx,
        y: translateStart.current.y + dy,
      });
    },
    [isDragging],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Double-click to toggle zoom
  const handleDoubleClick = useCallback(() => {
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  }, [scale]);

  if (!current) return null;

  const isZoomed = scale > 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={isZoomed ? undefined : onClose}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div
        className="relative flex flex-col items-center"
        style={{ maxWidth: '90vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between w-full mb-2 text-white" style={{ minWidth: 400 }}>
          <div className="text-base">
            <span className="font-medium">{current.franchise}</span>
            <span className="mx-2">/</span>
            <span>{current.page_label || `page ${currentIndex}`}</span>
            <span className="ml-2 text-gray-400">({current.card_ids.length}枚)</span>
          </div>
          <div className="flex items-center gap-3 text-base text-gray-400">
            {isZoomed && (
              <span className="text-sm bg-white/20 px-2 py-0.5 rounded">
                {Math.round(scale * 100)}% — ドラッグで移動 / 0でリセット
              </span>
            )}
            <span>
              {currentIndex + 1} / {images.length}
            </span>
          </div>
        </div>

        {/* Image — no overflow clip */}
        <div
          className="relative"
          style={{ cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in' }}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
        >
          {current.image_url && (
            <img
              ref={imgRef}
              src={`${current.image_url}?t=${Date.now()}`}
              alt={current.page_label || ''}
              className="max-h-[80vh] w-auto rounded shadow-2xl select-none"
              draggable={false}
              style={{
                transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.2s ease-out',
              }}
            />
          )}

          {/* Nav arrows — hide when zoomed */}
          {!isZoomed && hasPrev && (
            <button
              onClick={() => onNavigate(currentIndex - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white w-10 h-10 rounded-full flex items-center justify-center transition-colors"
            >
              ←
            </button>
          )}
          {!isZoomed && hasNext && (
            <button
              onClick={() => onNavigate(currentIndex + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white w-10 h-10 rounded-full flex items-center justify-center transition-colors"
            >
              →
            </button>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute -top-2 -right-2 bg-white text-gray-800 w-8 h-8 rounded-full flex items-center justify-center shadow hover:bg-gray-100 z-10"
        >
          ×
        </button>
      </div>
    </div>
  );
}
