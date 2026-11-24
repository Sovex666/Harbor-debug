const starts = new WeakMap<HTMLImageElement, number>();

// Parking is read from the DOM when the image scheduler grants a slot, not mirrored into React
// state: a per-card subscription re-rendered every unloaded poster and CoverImg on each tab switch.
const LAYER = ".harbor-layer-active, [data-layer-inactive]";
const layerOf = new WeakMap<Element, Element>();
const observedLayers = new WeakSet<Element>();
const resumeListeners = new Set<() => void>();
let layerObserver: MutationObserver | undefined;

const layerParked = (layer: Element) =>
  layer.hasAttribute("data-layer-inactive") || layer.classList.contains("hidden");

function observeLayer(layer: Element): void {
  if (observedLayers.has(layer) || typeof MutationObserver === "undefined") return;
  observedLayers.add(layer);
  layerObserver ??= new MutationObserver((records) => {
    if (records.some((record) => !layerParked(record.target as Element)))
      resumeListeners.forEach((listener) => listener());
  });
  layerObserver.observe(layer, {
    attributes: true,
    attributeFilter: ["data-layer-inactive", "class"],
  });
}

/**
 * Whether `element` sits in a parked App layer. Cheap enough to call on every scheduler pass: the
 * layer root is resolved once per element, then only its own attributes are read.
 */
export function isImageLayerParked(element: Element | null | undefined): boolean {
  if (!element) return false;
  let layer = layerOf.get(element);
  if (!layer) {
    layer = element.closest(LAYER) ?? undefined;
    if (!layer) return false;
    layerOf.set(element, layer);
    observeLayer(layer);
  }
  return layerParked(layer);
}

/** Runs `listener` when a layer seen by `isImageLayerParked` becomes active again. */
export function onImageLayerResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => resumeListeners.delete(listener);
}

/** Time from assigning a displayable source to browser load/decode readiness. */
export function beginImageReadiness(image: HTMLImageElement | null): void {
  if (image) starts.set(image, performance.now());
}
export function imageReadinessFields(image: HTMLImageElement): { elapsedMs?: number } {
  const start = starts.get(image);
  starts.delete(image);
  return start === undefined ? {} : { elapsedMs: Math.max(0, performance.now() - start) };
}
