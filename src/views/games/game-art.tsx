import { useEffect, useRef, useState } from "react";
import { gameLogoShape } from "@/lib/games/logo-art";
import { recordDiagnostic } from "@/lib/perf/diagnostics";
import { forgetFailedImage, useProxiedImageSrc } from "@/lib/remote-image-proxy";

// Failures are remembered for a few minutes, not the whole session, so reopening the library retries them.
const UNAVAILABLE_TTL = 5 * 60_000;
const RETRY_DELAYS = [3_000, 15_000];
const LOCAL_SRC = /^(asset|blob|file|data):|^https?:\/\/asset\.localhost/;
const unavailable = new Map<string, number>();
function isUnavailable(url: string): boolean {
  const until = unavailable.get(url);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  unavailable.delete(url);
  return false;
}
function markUnavailable(url: string): void {
  unavailable.delete(url);
  unavailable.set(url, Date.now() + UNAVAILABLE_TTL);
  if (unavailable.size > 200) unavailable.delete(unavailable.keys().next().value!);
}

export function GameArt({
  src,
  fallback,
  alt = "",
  className = "",
  eager = false,
  logo = false,
}: {
  src: string;
  fallback?: string;
  alt?: string;
  className?: string;
  eager?: boolean;
  logo?: boolean;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState("");
  const [shape, setShape] = useState<"compact" | "wide">("compact");
  const [retries, setRetries] = useState({ src: "", count: 0 });
  const retryCount = retries.src === src ? retries.count : 0;
  const candidates = [src, fallback].filter((url): url is string => !!url && !failed.includes(url));
  // A remembered failure only reorders the candidates; with no live alternative the primary is still tried.
  const source = candidates.find(url => !isUnavailable(url)) ?? candidates[0];
  const exhausted = !source && !!src;
  // The primary is retried only once the fallback has also failed, so the first failure shows the fallback at once.
  useEffect(() => {
    if (!exhausted) return;
    const delays = LOCAL_SRC.test(src) ? RETRY_DELAYS.slice(0, 1) : RETRY_DELAYS;
    if (retryCount >= delays.length) return;
    const timer = window.setTimeout(() => {
      forgetFailedImage(src);
      setFailed(previous => previous.filter(url => url !== src));
      setRetries({ src, count: retryCount + 1 });
    }, delays[retryCount]);
    return () => window.clearTimeout(timer);
  }, [exhausted, src, retryCount]);
  if (!source) return <span className={`${className} games-art-empty`} aria-hidden="true" />;
  return <ArtImage key={retryCount} url={source} className={className} alt={alt} eager={eager} logo={logo}
    loaded={loaded === source} shape={shape}
    onLoad={image => { setLoaded(source); if (logo) setShape(gameLogoShape(image.naturalWidth, image.naturalHeight)); }}
    onError={() => {
      recordDiagnostic("image:art-error", { local: LOCAL_SRC.test(source), insecure: source.startsWith("http://"), fallback: source !== src });
      markUnavailable(source);
      setFailed(previous => [...previous, source]);
    }} />;
}

function ArtImage({ url, className, alt, eager, logo, loaded, shape, onLoad, onError }: {
  url: string; className: string; alt: string; eager: boolean; logo: boolean; loaded: boolean; shape: "compact" | "wide";
  onLoad: (image: HTMLImageElement) => void; onError: () => void;
}) {
  // Only remote http(s) covers go through the proxy and disk cache; local asset, blob and file URLs are used directly.
  const remote = /^https?:\/\//.test(url) && !LOCAL_SRC.test(url);
  const [visible, setVisible] = useState(false);
  const nodeRef = useRef<HTMLElement | null>(null);
  const proxied = useProxiedImageSrc(remote ? url : undefined, {
    forceProxy: true, persistent: true, originalSize: true, priority: eager || visible ? "visible" : "background",
  });
  const art = remote ? proxied : url;
  const hasArt = !!art;
  // Off-screen covers stay on background priority, which still runs when this observer never fires.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node || eager || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, hasArt]);
  const bind = (node: HTMLElement | null) => { nodeRef.current = node; };
  if (!art) return <span ref={bind} className={`${className} games-art-empty`} aria-hidden="true" />;
  // Identity logos are hidden until decoded; native lazy loading cannot observe a hidden image.
  return <img ref={bind} className={className} src={art} alt={alt} loading={eager || logo ? "eager" : "lazy"} data-loaded={loaded}
    data-logo-shape={logo && loaded ? shape : undefined}
    decoding="async" onLoad={event => onLoad(event.currentTarget)} onError={onError} />;
}
