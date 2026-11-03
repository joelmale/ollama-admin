"use client";

import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useEffect, useState, useRef, useMemo } from "react";
import { Search, Check, Download, Loader2, CloudOff, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { useServers } from "@/lib/hooks/use-servers";
import { scoreModel, gradeColor, gradeBg, type Grade } from "@/lib/model-scoring";
import {
  assessVramFit,
  estimateVramGB,
  parseTagToSizeGB,
  vramFitBg,
  vramFitColor,
  type VramFit,
} from "@/lib/vram-estimate";
import { CAP_ICONS, CAP_COLORS } from "@/components/ui/capability-icons";

interface CatalogModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  pullCount: number;
  updated: string;
  updatedAt: string;
}

interface GpuSpecs {
  gpuName: string;
  vramGB: number;
  bandwidthGBs: number | null;
}

type SortKey = "popular" | "updated" | "name" | "size" | "grade";

const CAPABILITY_OPTIONS = ["text", "tools", "vision", "embedding", "thinking"];
const VRAM_PRESETS_GB = [4, 6, 8, 12, 16, 24, 32, 48, 80];
const VRAM_STORAGE_KEY = "discover.vramGB";
const VRAM_FITS: VramFit[] = ["comfortable", "tight", "exceeds"];
const VRAM_FIT_GLYPH: Record<VramFit, string> = { comfortable: "✓", tight: "!", exceeds: "✕" };

const GRADE_LABELS: Record<Grade, string> = {
  S: "≥50 t/s", A: "≥30 t/s", B: "≥15 t/s", C: "≥8 t/s", D: "≥3 t/s", F: "no fit",
};

const GRADE_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

function sortArrow(active: boolean, dir: 1 | -1) {
  if (!active) return <span className="opacity-30">↕</span>;
  return dir === 1 ? "↓" : "↑";
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
}: Readonly<{
  label: string;
  active: boolean;
  dir: 1 | -1;
  onClick: () => void;
  className: string;
}>) {
  return (
    <button
      onClick={onClick}
      className={`${className} items-center gap-0.5 transition-colors hover:text-[hsl(var(--foreground))] ${active ? "text-[hsl(var(--foreground))]" : ""}`}
    >
      {label} <span>{sortArrow(active, dir)}</span>
    </button>
  );
}

export default function DiscoverPage() {
  const t = useTranslations("discover");
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const { toast } = useToast();
  const { servers, selectedServer, setSelectedServer } = useServers();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCaps, setSelectedCaps] = useState<string[]>(["text"]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());
  const [downloadingRefs, setDownloadingRefs] = useState<Set<string>>(new Set());
  const [gpuSpecs, setGpuSpecs] = useState<GpuSpecs | null>(null);
  const [manualVram, setManualVram] = useState("");
  const [fitsGpuOnly, setFitsGpuOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("popular");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      setManualVram(localStorage.getItem(VRAM_STORAGE_KEY) ?? "");
    } catch {
      // storage unavailable (private mode); the value just won't persist
    }
  }, []);

  const updateManualVram = (value: string) => {
    setManualVram(value);
    try {
      if (value) localStorage.setItem(VRAM_STORAGE_KEY, value);
      else localStorage.removeItem(VRAM_STORAGE_KEY);
    } catch {
      // storage unavailable; keep the in-memory value
    }
  };

  useEffect(() => {
    if (!selectedServer) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/models?serverId=${selectedServer}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data.models && !cancelled) {
          setDownloadedModels(new Set(data.models.map((m: { name: string }) => m.name)));
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [selectedServer]);

  useEffect(() => {
    if (!selectedServer) return;
    fetch(`/api/gpu/specs?serverId=${selectedServer}`)
      .then((r) => r.json())
      .then((data: GpuSpecs | null) => setGpuSpecs(data))
      .catch(() => {});
  }, [selectedServer]);

  // Poll for download status
  useEffect(() => {
    if (downloadingRefs.size === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (!selectedServer) return;
      try {
        const [statusRes, modelsRes] = await Promise.all([
          fetch(`/api/admin/models/pull/status?serverId=${selectedServer}`),
          fetch(`/api/admin/models?serverId=${selectedServer}`),
        ]);

        if (statusRes.ok) {
          const jobs: { model: string; tag: string; status: string; error?: string }[] = await statusRes.json();
          for (const job of jobs) {
            const ref = job.tag ? `${job.model}:${job.tag}` : job.model;
            if (job.status === "error") {
              setDownloadingRefs((prev) => {
                if (!prev.has(ref)) return prev;
                const next = new Set(prev); next.delete(ref);
                toast(job.error ? `${t("pullError", { name: ref })}: ${job.error}` : t("pullError", { name: ref }), "error");
                return next;
              });
            }
          }
        }

        if (modelsRes.ok) {
          const data = await modelsRes.json();
          if (data.models) {
            const names = new Set<string>(data.models.map((m: { name: string }) => m.name));
            setDownloadedModels(names);
            setDownloadingRefs((prev) => {
              const next = new Set(prev); let changed = false;
              for (const ref of prev) {
                if (names.has(ref) || [...names].some((n) => n.startsWith(`${ref}-`))) {
                  next.delete(ref); changed = true;
                  toast(t("pullComplete", { name: ref }), "success");
                }
              }
              return changed ? next : prev;
            });
          }
        }
      } catch { /* ignore polling errors */ }
    }, 5000);

    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [downloadingRefs.size, selectedServer, t, toast]);

  useEffect(() => {
    const loadCatalog = async () => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (selectedCaps.length > 0) params.set("c", selectedCaps.join(","));
      try {
        const r = await fetch(`/api/catalog?${params}`);
        const data = await r.json().catch(() => null);
        if (r.ok && Array.isArray(data)) {
          setModels(data);
          setCatalogError(null);
        } else {
          setCatalogError(data?.error ?? t("catalogError"));
        }
      } catch {
        setCatalogError(t("catalogError"));
      } finally {
        setLoading(false);
      }
    };
    void loadCatalog();
  }, [search, selectedCaps, reloadKey, t]);

  const toggleCap = (cap: string) => {
    setSelectedCaps((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]);
  };

  const handlePull = async (modelName: string, tag?: string) => {
    if (!selectedServer) return;
    const ref = tag ? `${modelName}:${tag}` : modelName;
    if (downloadingRefs.has(ref)) return;
    setDownloadingRefs((prev) => new Set(prev).add(ref));
    try {
      const res = await fetch("/api/admin/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name: ref }),
      });
      if (!res.ok) {
        toast(t("pullError", { name: ref }), "error");
        setDownloadingRefs((prev) => { const next = new Set(prev); next.delete(ref); return next; });
        return;
      }
      toast(t("pullStarted", { name: ref }), "success");
    } catch {
      toast(t("pullError", { name: ref }), "error");
      setDownloadingRefs((prev) => { const next = new Set(prev); next.delete(ref); return next; });
    }
  };

  const isModelTagDownloaded = (modelName: string, tag: string) => {
    const ref = `${modelName}:${tag}`;
    for (const name of downloadedModels) {
      if (name === ref || name.startsWith(`${ref}-`)) return true;
    }
    return false;
  };

  const isDownloading = (modelName: string, tag: string) =>
    downloadingRefs.has(`${modelName}:${tag}`);

  const manualVramGB = useMemo(() => {
    const parsed = Number.parseFloat(manualVram);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [manualVram]);
  const vramGB = manualVramGB ?? gpuSpecs?.vramGB ?? null;

  const getTagScore = (tag: string) => {
    if (!gpuSpecs) return null;
    const sizeGB = parseTagToSizeGB(tag);
    if (sizeGB === null) return null;
    return scoreModel(sizeGB, gpuSpecs.vramGB, gpuSpecs.bandwidthGBs ?? undefined);
  };

  const getVramFit = (sizeGB: number | null) =>
    vramGB !== null && sizeGB !== null ? assessVramFit(estimateVramGB(sizeGB), vramGB) : null;

  // Flatten models × sizes into individual rows; apply the VRAM filter and sort.
  const flatRows = useMemo(() => {
    const rows = models.flatMap((model) => {
      const sizes = model.sizes.length > 0 ? model.sizes : ["latest"];
      const all = sizes.map((size) => ({ ...model, size, sizeGB: parseTagToSizeGB(size) }));
      if (fitsGpuOnly && vramGB !== null) {
        return all.filter(({ sizeGB }) => getVramFit(sizeGB)?.fit !== "exceeds");
      }
      return all;
    });

    type Row = (typeof rows)[number];
    const compare: Record<SortKey, (a: Row, b: Row) => number> = {
      popular: (a, b) => b.pullCount - a.pullCount,
      updated: (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => (a.sizeGB ?? Number.MAX_SAFE_INTEGER) - (b.sizeGB ?? Number.MAX_SAFE_INTEGER),
      grade: (a, b) => {
        const scoreA = getTagScore(a.size);
        const scoreB = getTagScore(b.size);
        const gradeA = scoreA ? GRADE_ORDER[scoreA.grade] ?? 6 : 6;
        const gradeB = scoreB ? GRADE_ORDER[scoreB.grade] ?? 6 : 6;
        if (gradeA !== gradeB) return gradeA - gradeB;
        return (scoreB?.tps ?? 0) - (scoreA?.tps ?? 0);
      },
    };
    const effectiveSort: SortKey = sortBy === "grade" && !gpuSpecs ? "popular" : sortBy;

    return [...rows].sort(
      (a, b) =>
        compare[effectiveSort](a, b) * sortDir ||
        a.name.localeCompare(b.name) ||
        (a.sizeGB ?? 0) - (b.sizeGB ?? 0)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, fitsGpuOnly, vramGB, gpuSpecs, sortBy, sortDir]);

  const selectSort = (key: SortKey) => {
    setSortDir(sortBy === key && sortDir === 1 ? -1 : 1);
    setSortBy(key);
  };

  const gpuLabel = gpuSpecs
    ? `${gpuSpecs.gpuName.replace(/NVIDIA GeForce /i, "").replace(/NVIDIA /i, "")} · ${Math.round(gpuSpecs.vramGB)}GB`
    : null;

  let listState: "loading" | "error" | "empty" | "ready" = "ready";
  if (loading) listState = "loading";
  else if (catalogError) listState = "error";
  else if (flatRows.length === 0) listState = "empty";

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {gpuLabel && (
          <span className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2.5 py-0.5 text-xs text-[hsl(var(--muted-foreground))]">
            {gpuLabel}
          </span>
        )}
      </div>

      {/* Search + Sort + Server */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchModels")} className="flex-1" />
        <div className="flex items-center gap-1.5">
          <Select
            value={sortBy}
            onChange={(e) => { setSortBy(e.target.value as SortKey); setSortDir(1); }}
            aria-label={t("sortBy")}
            className="w-auto"
          >
            <option value="popular">{t("sort.popular")}</option>
            <option value="updated">{t("sort.updated")}</option>
            <option value="name">{t("sort.name")}</option>
            <option value="size">{t("sort.size")}</option>
            {gpuSpecs && <option value="grade">{t("sort.grade")}</option>}
          </Select>
          <button
            onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}
            aria-label={t("reverseSort")}
            title={t("reverseSort")}
            className="rounded-md border border-[hsl(var(--border))] p-2 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
          >
            <ArrowUpDown className="h-4 w-4" />
          </button>
        </div>
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
      </div>

      {/* Capability filters + Fits GPU */}
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by capability">
        {CAPABILITY_OPTIONS.map((cap) => (
          <button
            key={cap}
            onClick={() => toggleCap(cap)}
            aria-pressed={selectedCaps.includes(cap)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              selectedCaps.includes(cap)
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t(`capabilities.${cap}`)}
          </button>
        ))}
        {vramGB !== null && (
          <button
            onClick={() => setFitsGpuOnly((v) => !v)}
            aria-pressed={fitsGpuOnly}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              fitsGpuOnly
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t("fitsGpu")}
          </button>
        )}
      </div>

      {/* VRAM */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
        <label htmlFor="discover-vram" className="font-semibold text-[hsl(var(--foreground))]">
          {t("vramLabel")}
        </label>
        <div className="w-24">
          <Input
            id="discover-vram"
            type="number"
            min={1}
            max={1024}
            step={1}
            list="discover-vram-presets"
            value={manualVram}
            onChange={(e) => updateManualVram(e.target.value)}
            placeholder={gpuSpecs ? String(Math.round(gpuSpecs.vramGB)) : "24"}
          />
        </div>
        <datalist id="discover-vram-presets">
          {VRAM_PRESETS_GB.map((gb) => <option key={gb} value={gb} />)}
        </datalist>
        {gpuLabel && <span>{t("vramDetected", { gpu: gpuLabel })}</span>}
        {manualVram && gpuSpecs && (
          <button
            onClick={() => updateManualVram("")}
            className="underline underline-offset-2 hover:text-[hsl(var(--foreground))]"
          >
            {t("vramUseDetected")}
          </button>
        )}
        {vramGB === null && <span>{t("vramHint")}</span>}
        {vramGB !== null && (
          <span className="flex flex-wrap items-center gap-1.5" title={t("vramLegend")}>
            {VRAM_FITS.map((fit) => (
              <span
                key={fit}
                className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                style={{ color: vramFitColor(fit), background: vramFitBg(fit) }}
              >
                <span aria-hidden>{VRAM_FIT_GLYPH[fit]} </span>
                {t(`vramFit.${fit}`)}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* GPU grade legend */}
      {gpuSpecs && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="font-semibold text-[hsl(var(--foreground))]">GPU:</span>
          {(["S", "A", "B", "C", "D", "F"] as Grade[]).map((g) => (
            <span key={g} className="flex items-center gap-1.5">
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ color: gradeColor(g), background: gradeBg(g) }}>
                {g}
              </span>
              <span>{GRADE_LABELS[g]}</span>
            </span>
          ))}
        </div>
      )}

      {/* Model list */}
      {listState === "loading" && (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-6 border-b border-[hsl(var(--border))] px-4 py-3 last:border-0">
              <div className="h-4 w-40 animate-pulse rounded bg-[hsl(var(--muted))]" />
              <div className="h-4 flex-1 animate-pulse rounded bg-[hsl(var(--muted))] opacity-30" />
              <div className="h-4 w-20 animate-pulse rounded bg-[hsl(var(--muted))]" />
              <div className="h-6 w-6 animate-pulse rounded bg-[hsl(var(--muted))]" />
            </div>
          ))}
        </div>
      )}
      {listState === "error" && (
        <EmptyState
          icon={CloudOff}
          title={t("catalogErrorTitle")}
          description={catalogError ?? ""}
          action={
            <Button
              onClick={() => {
                setLoading(true);
                setReloadKey((k) => k + 1);
              }}
            >
              {t("retry")}
            </Button>
          }
        />
      )}
      {listState === "empty" && (
        <EmptyState icon={Search} title={t("emptyTitle")} description={t("emptyDescription")} />
      )}
      {listState === "ready" && (
        <div className="mt-4 rounded-lg border border-[hsl(var(--border))]">
          {/* Column headers */}
          <div className="flex items-center gap-4 rounded-t-lg border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.6)] px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            <SortHeader
              label={t("columns.model")}
              active={sortBy === "name"}
              dir={sortDir}
              onClick={() => selectSort("name")}
              className="flex flex-1 justify-start uppercase"
            />
            <SortHeader
              label={t("columns.pulls")}
              active={sortBy === "popular"}
              dir={sortDir}
              onClick={() => selectSort("popular")}
              className="hidden w-20 shrink-0 justify-end md:flex"
            />
            <SortHeader
              label={t("columns.updated")}
              active={sortBy === "updated"}
              dir={sortDir}
              onClick={() => selectSort("updated")}
              className="hidden w-24 shrink-0 justify-end sm:flex"
            />
            <SortHeader
              label={t("columns.size")}
              active={sortBy === "size"}
              dir={sortDir}
              onClick={() => selectSort("size")}
              className="flex w-20 shrink-0 justify-end"
            />
            {vramGB !== null && <span className="w-28 shrink-0 text-right">{t("columns.vram")}</span>}
            {gpuSpecs && <span className="w-24 shrink-0 text-right hidden md:block">{t("columns.speed")}</span>}
            {gpuSpecs && (
              <SortHeader
                label={t("columns.grade")}
                active={sortBy === "grade"}
                dir={sortDir}
                onClick={() => selectSort("grade")}
                className="flex w-16 shrink-0 justify-center whitespace-nowrap"
              />
            )}
            <span className="w-8 shrink-0" />
          </div>

          {flatRows.map((row, idx) => {
            const downloaded = isModelTagDownloaded(row.name, row.size);
            const pulling = isDownloading(row.name, row.size);
            const score = getTagScore(row.size);
            const fit = getVramFit(row.sizeGB);
            const gbDigits = row.sizeGB != null && row.sizeGB < 10 ? 1 : 0;
            const gbLabel = row.sizeGB == null ? null : `${row.sizeGB.toFixed(gbDigits)} GB`;
            const isLast = idx === flatRows.length - 1;

            const nameBlock = (
              <div
                tabIndex={row.description ? 0 : undefined}
                className={`min-w-0 flex items-center gap-2 flex-wrap rounded ${fit?.fit === "exceeds" ? "opacity-60" : ""}`}
              >
                <span className="font-semibold truncate">{row.name}</span>
                <span className="shrink-0 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
                  {row.size}
                </span>
              </div>
            );

            const rowInner = (
              <div className={[
                "flex items-center gap-4 px-4 py-3 text-sm",
                !isLast ? "border-b border-[hsl(var(--border))]" : "",
              ].join(" ")}>
                {/* Name + size tag + capability icons */}
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  {row.description ? (
                    <Tooltip
                      content={row.description}
                      side="bottom"
                      wrapperClassName="min-w-0"
                      className="left-0 w-80 max-w-[80vw] translate-x-0 whitespace-normal text-left"
                    >
                      {nameBlock}
                    </Tooltip>
                  ) : (
                    nameBlock
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    {row.capabilities.map((cap) => (
                      <span key={cap} title={cap} style={{ color: CAP_COLORS[cap] ?? "hsl(var(--muted-foreground))" }}>
                        {CAP_ICONS[cap] ?? null}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Pulls */}
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))] hidden md:block">
                  {row.pulls}
                </span>

                {/* Updated */}
                <span className="w-24 shrink-0 text-right text-xs text-[hsl(var(--muted-foreground))] hidden sm:block">
                  {row.updated}
                </span>

                {/* Download size */}
                <div className="w-20 shrink-0 text-right">
                  {gbLabel && <span className="tabular-nums">{gbLabel}</span>}
                </div>

                {/* Estimated VRAM and fit */}
                {vramGB !== null && (
                  <div className="w-28 shrink-0 flex justify-end">
                    {fit ? (
                      <span
                        title={t("vramEstimate", { gb: fit.neededGB.toFixed(1), pct: Math.round(fit.pct) })}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
                        style={{ color: vramFitColor(fit.fit), background: vramFitBg(fit.fit) }}
                      >
                        <span aria-hidden>{VRAM_FIT_GLYPH[fit.fit]}</span>
                        ~{fit.neededGB.toFixed(1)} GB
                        <span className="sr-only">{t(`vramFit.${fit.fit}`)}</span>
                      </span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Speed */}
                {gpuSpecs && (
                  <div className="w-24 shrink-0 text-right text-sm tabular-nums hidden md:block">
                    {score?.fits && score.tps > 0 ? (
                      <span style={{ color: gradeColor(score.grade) }}>~{Math.round(score.tps)} t/s</span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Grade */}
                {gpuSpecs && (
                  <div className="w-16 shrink-0 flex justify-center">
                    {score ? (
                      <span className="text-xl font-bold leading-none" style={{ color: gradeColor(score.grade) }}>
                        {score.grade}
                      </span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Action */}
                <div className="w-8 shrink-0 flex justify-end">
                  {downloaded && <Check className="h-4 w-4 text-[hsl(142_71%_45%)]" />}
                  {!downloaded && pulling && (
                    <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--muted-foreground))]" />
                  )}
                  {!downloaded && !pulling && isAdmin && (
                    <button
                      onClick={() => handlePull(row.name, row.size !== "latest" ? row.size : undefined)}
                      disabled={!selectedServer}
                      aria-label={`${t("pullModel")} ${row.name}:${row.size}`}
                      className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );

            return <div key={`${row.id}-${row.size}`}>{rowInner}</div>;
          })}
        </div>
      )}
    </div>
  );
}
