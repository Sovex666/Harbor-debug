import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { useProxiedImageSrc } from "@/lib/remote-image-proxy";
import { observeWithin } from "@/lib/visibility";
import { beginImageReadiness } from "@/lib/image-readiness";

export function CoverImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(rest.loading === "eager");
  useEffect(() => {
    if (visible || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    return observeWithin(ref.current, "200px", (entry) => {
      if (entry.isIntersecting) setVisible(true);
    });
  }, [visible]);
  // The scheduler holds the fetch while this image's layer is parked; a switch re-renders nothing.
  const resolved = useProxiedImageSrc(src, { enabled: visible, layerRef: ref });
  useEffect(() => {
    beginImageReadiness(ref.current);
  }, [resolved]);
  return <img ref={ref} decoding="async" loading="lazy" {...rest} src={resolved} />;
}
