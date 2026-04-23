import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Play,
  RefreshCcw,
  Star,
  StarOff,
  Trash2,
  X,
} from "lucide-react";

import { api } from "./lib/api";
import { basename, formatBytes, formatCount } from "./lib/format";
import { addRecentRoot, defaultSettings, toggleFavorite } from "./lib/settings";
import {
  flattenExpandedRows,
  initialScanProgress,
  scanReducer,
} from "./lib/scanState";
import type {
  AppSettings,
  ExtensionRow,
  FlatRow,
  NodeRow,
  ScanOptions,
  SortBy,
  SortDirection,
  SortSpec,
  VolumeInfo,
} from "./lib/types";
import "./styles.css";

const rootNodeId = 0;

const defaultScanOptions: ScanOptions = {
  includeHidden: true,
  stayOnFilesystem: false,
  followSymlinks: false,
  computeAllocated: true,
};

const defaultSort: SortSpec = {
  by: "logicalBytes",
  direction: "desc",
};

export default function App() {
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [scanId, setScanId] = useState<string | null>(null);
  const [progress, dispatchProgress] = useReducer(scanReducer, initialScanProgress);
  const [sort, setSort] = useState<SortSpec>(defaultSort);
  const [childCache, setChildCache] = useState<Map<number, NodeRow[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set([rootNodeId]));
  const [topFiles, setTopFiles] = useState<NodeRow[]>([]);
  const [topFolders, setTopFolders] = useState<NodeRow[]>([]);
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(
    () => flattenExpandedRows(rootNodeId, childCache, expanded),
    [childCache, expanded],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 38,
    overscan: 12,
  });

  useEffect(() => {
    let active = true;
    Promise.all([api.listVolumes(), api.getSettings()])
      .then(([nextVolumes, nextSettings]) => {
        if (!active) {
          return;
        }
        setVolumes(nextVolumes);
        setSettings(nextSettings);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(messageFromError(loadError));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!scanId || (progress.status !== "complete" && progress.status !== "cancelled")) {
      return;
    }
    void refreshScanData(scanId);
  }, [progress.status, scanId, sort]);

  async function refreshScanData(activeScanId: string) {
    try {
      const [children, files, folders, breakdown, info] = await Promise.all([
        api.getChildren(activeScanId, null, sort, 0, 1_000),
        api.getTopItems(activeScanId, "files", 20),
        api.getTopItems(activeScanId, "directories", 20),
        api.getExtensionBreakdown(activeScanId, 20),
        api.getScanSummary(activeScanId),
      ]);
      setChildCache(new Map([[rootNodeId, children.items]]));
      setExpanded(new Set([rootNodeId]));
      setTopFiles(files);
      setTopFolders(folders);
      setExtensions(breakdown);
      setStale(info.stale);
    } catch (refreshError) {
      setError(messageFromError(refreshError));
    }
  }

  async function startScan(root: string) {
    setError(null);
    setStale(false);
    setSelectedPath(root);
    setChildCache(new Map());
    setExpanded(new Set([rootNodeId]));
    setTopFiles([]);
    setTopFolders([]);
    setExtensions([]);
    dispatchProgress({ type: "started", root });

    try {
      const nextSettings = {
        ...settings,
        recentRoots: addRecentRoot(settings.recentRoots, root),
      };
      setSettings(nextSettings);
      await api.saveSettings(nextSettings);
      const handle = await api.startScan(root, defaultScanOptions, dispatchProgress);
      setScanId(handle.scanId);
    } catch (scanError) {
      setError(messageFromError(scanError));
    }
  }

  async function chooseFolder() {
    const folder = await api.pickFolder();
    if (folder) {
      await startScan(folder);
    }
  }

  async function cancelScan() {
    if (!scanId) {
      return;
    }
    try {
      await api.cancelScan(scanId);
    } catch (cancelError) {
      setError(messageFromError(cancelError));
    }
  }

  async function updateFavorite(root: string) {
    const next = {
      ...settings,
      favoriteRoots: toggleFavorite(settings.favoriteRoots, root),
    };
    setSettings(next);
    await api.saveSettings(next);
  }

  async function toggleRow(row: NodeRow) {
    if (row.kind !== "directory" || row.childCount === 0 || !scanId) {
      return;
    }

    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(row.id)) {
      nextExpanded.delete(row.id);
      setExpanded(nextExpanded);
      return;
    }

    if (!childCache.has(row.id)) {
      try {
        const children = await api.getChildren(scanId, row.id, sort, 0, 1_000);
        setChildCache((current) => {
          const next = new Map(current);
          next.set(row.id, children.items);
          return next;
        });
      } catch (loadError) {
        setError(messageFromError(loadError));
        return;
      }
    }

    nextExpanded.add(row.id);
    setExpanded(nextExpanded);
  }

  function changeSort(by: SortBy) {
    setSort((current) => ({
      by,
      direction:
        current.by === by && current.direction === "desc"
          ? "asc"
          : ("desc" as SortDirection),
    }));
  }

  async function reveal(row: NodeRow) {
    if (!scanId) {
      return;
    }
    await api.revealItem(scanId, row.id).catch((revealError) => {
      setError(messageFromError(revealError));
    });
  }

  async function open(row: NodeRow) {
    if (!scanId) {
      return;
    }
    await api.openItem(scanId, row.id).catch((openError) => {
      setError(messageFromError(openError));
    });
  }

  async function trash(row: NodeRow) {
    if (!scanId) {
      return;
    }
    const confirmed = window.confirm(`Move ${row.path} to Trash?`);
    if (!confirmed) {
      return;
    }
    try {
      const info = await api.trashItem(scanId, row.id);
      setStale(info.stale);
    } catch (trashError) {
      setError(messageFromError(trashError));
    }
  }

  const running = progress.status === "running";
  const summary = progress.summary;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <HardDrive size={22} />
          <div>
            <strong>Disk Usage</strong>
            <span>{volumes.length} volumes</span>
          </div>
        </div>

        <button className="primary-action" type="button" onClick={chooseFolder}>
          <FolderOpen size={17} />
          Choose Folder
        </button>

        <SidebarSection title="Volumes">
          {volumes.map((volume) => (
            <button
              className="root-row"
              key={volume.mountPoint}
              type="button"
              onClick={() => void startScan(volume.mountPoint)}
            >
              <span>
                <strong>{volume.name || volume.mountPoint}</strong>
                <small>{volume.mountPoint}</small>
              </span>
              <span className="capacity">
                {formatBytes(volume.totalBytes - volume.availableBytes)}
              </span>
            </button>
          ))}
        </SidebarSection>

        <SidebarSection title="Favorites">
          {settings.favoriteRoots.length === 0 ? (
            <p className="muted-line">None</p>
          ) : (
            settings.favoriteRoots.map((root) => (
              <RootShortcut
                key={root}
                root={root}
                favorite
                onScan={startScan}
                onFavorite={updateFavorite}
              />
            ))
          )}
        </SidebarSection>

        <SidebarSection title="Recent">
          {settings.recentRoots.length === 0 ? (
            <p className="muted-line">None</p>
          ) : (
            settings.recentRoots.map((root) => (
              <RootShortcut
                key={root}
                root={root}
                favorite={settings.favoriteRoots.includes(root)}
                onScan={startScan}
                onFavorite={updateFavorite}
              />
            ))
          )}
        </SidebarSection>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="scan-title">
            <span>{selectedPath ? basename(selectedPath) : "No scan loaded"}</span>
            <strong>{selectedPath ?? "No scan loaded"}</strong>
          </div>
          <div className="toolbar-actions">
            {stale ? <span className="stale-badge">Stale</span> : null}
            {running ? (
              <button className="icon-button danger" type="button" onClick={cancelScan} title="Cancel scan">
                <X size={17} />
              </button>
            ) : selectedPath ? (
              <button className="icon-button" type="button" onClick={() => void startScan(selectedPath)} title="Rescan">
                <RefreshCcw size={17} />
              </button>
            ) : null}
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="metrics-band">
          <Metric label="Logical" value={formatBytes(summary?.totalLogicalBytes ?? 0)} />
          <Metric label="Allocated" value={formatBytes(summary?.totalAllocatedBytes ?? null)} />
          <Metric label="Files" value={formatCount(summary?.fileCount ?? 0)} />
          <Metric label="Folders" value={formatCount(summary?.directoryCount ?? 0)} />
          <Metric label="Errors" value={formatCount(summary?.errorCount ?? progress.errors.length)} />
        </section>

        <section className="content-grid">
          <div className="table-region">
            <div className="table-header">
              <button type="button" onClick={() => changeSort("name")}>Name</button>
              <button type="button" onClick={() => changeSort("logicalBytes")}>Logical</button>
              <button type="button" onClick={() => changeSort("allocatedBytes")}>Allocated</button>
              <button type="button" onClick={() => changeSort("kind")}>Kind</button>
              <span>Actions</span>
            </div>

            {running ? (
              <div className="scan-progress">
                <LoaderCircle className="spin" size={24} />
                <strong>{formatCount(progress.entriesScanned)} entries</strong>
                <span>{formatBytes(progress.bytesScanned)}</span>
                <small>{progress.currentPath}</small>
              </div>
            ) : rows.length === 0 ? (
              <div className="empty-state">No scan loaded</div>
            ) : (
              <div className="virtual-table" ref={scrollRef}>
                <div
                  className="virtual-spacer"
                  style={{ height: `${virtualizer.getTotalSize()}px` }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const flatRow = rows[virtualRow.index];
                    return (
                      <FileRow
                        key={flatRow.row.id}
                        flatRow={flatRow}
                        expanded={expanded.has(flatRow.row.id)}
                        top={virtualRow.start}
                        onToggle={toggleRow}
                        onOpen={open}
                        onReveal={reveal}
                        onTrash={trash}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <aside className="inspector">
            <InsightList title="Largest Files" rows={topFiles} />
            <InsightList title="Largest Folders" rows={topFolders} />
            <ExtensionList rows={extensions} />
          </aside>
        </section>
      </section>
    </main>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sidebar-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function RootShortcut({
  root,
  favorite,
  onScan,
  onFavorite,
}: {
  root: string;
  favorite: boolean;
  onScan: (root: string) => Promise<void>;
  onFavorite: (root: string) => Promise<void>;
}) {
  return (
    <div className="shortcut-row">
      <button type="button" onClick={() => void onScan(root)}>
        <Play size={14} />
        <span>{root}</span>
      </button>
      <button
        className="icon-button compact"
        type="button"
        onClick={() => void onFavorite(root)}
        title={favorite ? "Remove favorite" : "Add favorite"}
      >
        {favorite ? <StarOff size={14} /> : <Star size={14} />}
      </button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FileRow({
  flatRow,
  expanded,
  top,
  onToggle,
  onOpen,
  onReveal,
  onTrash,
}: {
  flatRow: FlatRow;
  expanded: boolean;
  top: number;
  onToggle: (row: NodeRow) => Promise<void>;
  onOpen: (row: NodeRow) => Promise<void>;
  onReveal: (row: NodeRow) => Promise<void>;
  onTrash: (row: NodeRow) => Promise<void>;
}) {
  const { row, depth } = flatRow;
  const expandable = row.kind === "directory" && row.childCount > 0;

  return (
    <div className="file-row" style={{ transform: `translateY(${top}px)` }}>
      <div className="name-cell" style={{ paddingLeft: `${depth * 18 + 10}px` }}>
        <button
          className="disclosure"
          type="button"
          disabled={!expandable}
          onClick={() => void onToggle(row)}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expandable ? expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : null}
        </button>
        <span className={`kind-dot ${row.kind}`} />
        <span className="truncate">{row.name}</span>
      </div>
      <div>{formatBytes(row.logicalBytes)}</div>
      <div>{formatBytes(row.allocatedBytes)}</div>
      <div className="kind-cell">{row.kind}</div>
      <div className="row-actions">
        <button type="button" className="icon-button compact" title="Open" onClick={() => void onOpen(row)}>
          <FolderOpen size={14} />
        </button>
        <button type="button" className="icon-button compact" title="Reveal" onClick={() => void onReveal(row)}>
          <Eye size={14} />
        </button>
        <button type="button" className="icon-button compact danger" title="Move to Trash" onClick={() => void onTrash(row)}>
          <Trash2 size={14} />
        </button>
      </div>
      <span className="row-bar" style={{ width: `${Math.min(row.percentOfRoot, 100)}%` }} />
    </div>
  );
}

function InsightList({ title, rows }: { title: string; rows: NodeRow[] }) {
  return (
    <section className="insight-panel">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted-line">None</p>
      ) : (
        rows.slice(0, 8).map((row) => (
          <div className="insight-row" key={`${title}-${row.id}`}>
            <span className="truncate">{row.name}</span>
            <strong>{formatBytes(row.logicalBytes)}</strong>
          </div>
        ))
      )}
    </section>
  );
}

function ExtensionList({ rows }: { rows: ExtensionRow[] }) {
  return (
    <section className="insight-panel">
      <h2>Extensions</h2>
      {rows.length === 0 ? (
        <p className="muted-line">None</p>
      ) : (
        rows.slice(0, 8).map((row) => (
          <div className="insight-row" key={row.extension}>
            <span>.{row.extension}</span>
            <strong>{formatBytes(row.logicalBytes)}</strong>
          </div>
        ))
      )}
    </section>
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unexpected error";
}

export function mountApp(element: HTMLElement) {
  createRoot(element).render(<App />);
}
