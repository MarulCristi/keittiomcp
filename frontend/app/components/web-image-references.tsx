"use client";

import { useEffect, useState } from "react";
import { ExternalLink, ImageOff, Images } from "lucide-react";
import { api } from "../lib/purchasing";

type Reference = { title: string; image_url: string; source_url: string; source_domain: string };
type Result = { status: "ready" | "empty" | "not_configured" | "unavailable"; images: Reference[] };
type Lookup = Result | { status: "loading"; images: Reference[] };

async function loadImages(query: string): Promise<Result> {
  const signal = AbortSignal.timeout(110000);
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await api<Lookup>(`image_references?${new URLSearchParams({ query })}`, "GET", undefined, signal);
    if (result.status !== "loading") return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { status: "unavailable", images: [] };
}

// Share requests across chat re-renders; avoid duplicate paid lookups in Strict Mode.
const requests = new Map<string, Promise<Result>>();
function findImages(query: string) {
  let pending = requests.get(query);
  if (!pending) {
    pending = loadImages(query)
      .catch((): Result => ({ status: "unavailable", images: [] }));
    requests.set(query, pending);
    void pending.then((result) => {
      if (result.status !== "ready" && requests.get(query) === pending) requests.delete(query);
    });
    if (requests.size > 100) requests.delete(requests.keys().next().value!);
  }
  return pending;
}

function Thumbnail({ reference }: { reference: Reference }) {
  const [failed, setFailed] = useState(false);
  return <a className="web-image-card" href={reference.source_url} target="_blank" rel="noopener noreferrer" title={reference.title}>
    <span className="web-image-thumbnail">
      {failed ? <span className="web-image-fallback"><ImageOff size={20} /><span>View source</span></span> :
        // Preserve the source image; no generation, download proxy or Next image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={reference.image_url} alt={reference.title} width={112} height={76} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
    </span>
    <span className="web-image-title">{reference.title}</span>
    <span className="web-image-source"><span>{reference.source_domain.replace(/^www\./, "")}</span><ExternalLink size={10} aria-hidden="true" /></span>
  </a>;
}

export default function WebImageReferences({ query }: { query: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    void findImages(query).then((next) => { if (active) setResult(next); });
    return () => { active = false; };
  }, [query, attempt]);

  return <section className="web-image-references" aria-label={`Web image references for ${query}`}>
    <div className="web-image-heading"><Images size={14} aria-hidden="true" /><strong>Product lookup · Web images</strong></div>
    {!result ? <p className="web-image-note" role="status">Finding website images for {query}…</p> :
      result.status === "ready" && result.images.length > 0 ? <>
        <div className="web-image-grid">{result.images.slice(0, 3).map((reference) => <Thumbnail key={reference.image_url} reference={reference} />)}</div>
        <p className="web-image-note">Via Oxylabs · Visual references; packaging may differ. Open a source to check details.</p>
      </> : <div className="web-image-note" role="status">
        <span>{result.status === "not_configured" ? "Website images will appear once the image search is connected." : result.status === "empty" ? "No website images found for this product." : "Website images are temporarily unavailable."}</span>
        <button type="button" className="text-button" onClick={() => { requests.delete(query); setAttempt((value) => value + 1); }}>Retry images</button>
      </div>}
  </section>;
}
