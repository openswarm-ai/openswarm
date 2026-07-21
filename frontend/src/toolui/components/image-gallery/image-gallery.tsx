"use client";

import "./styles.css";
import { cn } from "./_adapter";
import { ImageGalleryProvider } from "./context";
import { GalleryGrid } from "./gallery-grid";
import { GalleryLightbox } from "./gallery-lightbox";
import type { ImageGalleryProps } from "./schema";

export function ImageGallery({
  id,
  images,
  title,
  description,
  className,
  onImageClick,
}: ImageGalleryProps) {
  const handleImageClick = (imageId: string) => {
    if (!onImageClick) return;

    const image = images.find((img) => img.id === imageId);
    if (image) {
      onImageClick(imageId, image);
    }
  };

  return (
    <article
      className={cn("relative w-full min-w-80 max-w-lg", className)}
      data-tool-ui-id={id}
      data-slot="image-gallery"
    >
      <div
        className={cn(
          "@container relative isolate flex w-full min-w-0 flex-col rounded-xl",
          "border border-border bg-card text-sm shadow-xs",
        )}
      >
        <ImageGalleryProvider images={images}>
          <Header title={title} description={description} />
          <div className="p-3">
            <GalleryGrid onImageClick={handleImageClick} />
          </div>
          <GalleryLightbox />
        </ImageGalleryProvider>
      </div>
    </article>
  );
}

interface HeaderProps {
  title?: string;
  description?: string;
}

function Header({ title, description }: HeaderProps) {
  if (!title && !description) {
    return null;
  }

  return (
    <div className="border-border/60 border-b px-4 pt-4 pb-3">
      {title && (
        <h3 className="text-[15px] leading-tight font-semibold tracking-tight">
          {title}
        </h3>
      )}
      {description && (
        <p className="text-muted-foreground mt-1 text-sm leading-snug">
          {description}
        </p>
      )}
    </div>
  );
}
