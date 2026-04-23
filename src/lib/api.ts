import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { LazyStore } from "@tauri-apps/plugin-store";

import { addRecentRoot, defaultSettings, sanitizeSettings } from "./settings";
import type {
  AppSettings,
  ExtensionRow,
  NodeRow,
  Page,
  ScanEvent,
  ScanHandle,
  ScanInfo,
  ScanOptions,
  SortSpec,
  TopKind,
  VolumeInfo,
} from "./types";

const SETTINGS_KEY = "roots";

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function getStoreSettings(): Promise<AppSettings> {
  if (!isTauriRuntime()) {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw) as Partial<AppSettings>) : defaultSettings;
  }

  const store = new LazyStore("settings.json");
  const stored = await store.get<Partial<AppSettings>>(SETTINGS_KEY);
  return sanitizeSettings(stored);
}

async function saveStoreSettings(settings: AppSettings): Promise<void> {
  const sanitized = sanitizeSettings(settings);
  if (!isTauriRuntime()) {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    return;
  }

  const store = new LazyStore("settings.json");
  await store.set(SETTINGS_KEY, sanitized);
  await store.save();
}

const mockRows: NodeRow[] = [
  {
    id: 1,
    name: "Applications",
    path: "/Applications",
    kind: "directory",
    logicalBytes: 32_400_000_000,
    allocatedBytes: 33_100_000_000,
    fileCount: 8_420,
    directoryCount: 490,
    symlinkCount: 12,
    childCount: 0,
    percentOfRoot: 48,
  },
  {
    id: 2,
    name: "Users",
    path: "/Users",
    kind: "directory",
    logicalBytes: 24_200_000_000,
    allocatedBytes: 25_000_000_000,
    fileCount: 42_000,
    directoryCount: 3_900,
    symlinkCount: 30,
    childCount: 0,
    percentOfRoot: 36,
  },
  {
    id: 3,
    name: "large-video.mov",
    path: "/large-video.mov",
    kind: "file",
    logicalBytes: 8_100_000_000,
    allocatedBytes: 8_100_003_840,
    fileCount: 1,
    directoryCount: 0,
    symlinkCount: 0,
    childCount: 0,
    percentOfRoot: 12,
  },
];

export const api = {
  async listVolumes(): Promise<VolumeInfo[]> {
    if (isTauriRuntime()) {
      return invoke<VolumeInfo[]>("list_volumes");
    }
    return [
      {
        name: "Macintosh HD",
        mountPoint: "/",
        fileSystem: "apfs",
        totalBytes: 994_000_000_000,
        availableBytes: 302_000_000_000,
        isRemovable: false,
      },
      {
        name: "5TB",
        mountPoint: "/Volumes/5TB",
        fileSystem: "apfs",
        totalBytes: 5_000_000_000_000,
        availableBytes: 1_700_000_000_000,
        isRemovable: true,
      },
    ];
  },

  async pickFolder(): Promise<string | null> {
    if (!isTauriRuntime()) {
      return "/";
    }
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },

  async getSettings(): Promise<AppSettings> {
    return getStoreSettings();
  },

  async saveSettings(settings: AppSettings): Promise<void> {
    await saveStoreSettings(settings);
  },

  async rememberRoot(settings: AppSettings, root: string): Promise<AppSettings> {
    const next = {
      ...settings,
      recentRoots: addRecentRoot(settings.recentRoots, root),
    };
    await saveStoreSettings(next);
    return next;
  },

  async startScan(
    root: string,
    options: ScanOptions,
    onEvent: (event: ScanEvent) => void,
  ): Promise<ScanHandle> {
    if (isTauriRuntime()) {
      const progressChannel = new Channel<ScanEvent>();
      progressChannel.onmessage = onEvent;
      return invoke<ScanHandle>("start_scan", {
        root,
        options,
        progress_channel: progressChannel,
      });
    }

    const summary = {
      root,
      totalLogicalBytes: 67_200_000_000,
      totalAllocatedBytes: 68_100_000_000,
      fileCount: 50_421,
      directoryCount: 4_390,
      symlinkCount: 42,
      errorCount: 0,
      cancelled: false,
    };
    window.setTimeout(() => onEvent({ type: "started", root }), 20);
    window.setTimeout(
      () =>
        onEvent({
          type: "progress",
          entriesScanned: 12_450,
          bytesScanned: 12_000_000_000,
          currentPath: `${root}/Users`,
        }),
      120,
    );
    window.setTimeout(() => onEvent({ type: "completed", summary }), 300);
    return { scanId: "mock-scan" };
  },

  async cancelScan(scanId: string): Promise<ScanInfo> {
    if (isTauriRuntime()) {
      return invoke<ScanInfo>("cancel_scan", { scan_id: scanId });
    }
    return {
      scanId,
      status: "cancelled",
      stale: false,
      summary: null,
      errorMessage: null,
    };
  },

  async getScanSummary(scanId: string): Promise<ScanInfo> {
    if (isTauriRuntime()) {
      return invoke<ScanInfo>("get_scan_summary", { scan_id: scanId });
    }
    return {
      scanId,
      status: "complete",
      stale: false,
      summary: null,
      errorMessage: null,
    };
  },

  async getChildren(
    scanId: string,
    nodeId: number | null,
    sort: SortSpec,
    offset: number,
    limit: number,
  ): Promise<Page<NodeRow>> {
    if (isTauriRuntime()) {
      return invoke<Page<NodeRow>>("get_children", {
        scan_id: scanId,
        node_id: nodeId,
        sort,
        offset,
        limit,
      });
    }
    const rows = [...mockRows].sort((left, right) => {
      const direction = sort.direction === "asc" ? 1 : -1;
      if (sort.by === "name") {
        return left.name.localeCompare(right.name) * direction;
      }
      const leftValue = sort.by === "allocatedBytes" ? left.allocatedBytes ?? left.logicalBytes : left.logicalBytes;
      const rightValue = sort.by === "allocatedBytes" ? right.allocatedBytes ?? right.logicalBytes : right.logicalBytes;
      return (leftValue - rightValue) * direction;
    });
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      limit,
    };
  },

  async getTopItems(scanId: string, kind: TopKind, limit: number): Promise<NodeRow[]> {
    if (isTauriRuntime()) {
      return invoke<NodeRow[]>("get_top_items", { scan_id: scanId, kind, limit });
    }
    return mockRows.filter((row) => row.kind === (kind === "files" ? "file" : "directory")).slice(0, limit);
  },

  async getExtensionBreakdown(scanId: string, limit: number): Promise<ExtensionRow[]> {
    if (isTauriRuntime()) {
      return invoke<ExtensionRow[]>("get_extension_breakdown", { scan_id: scanId, limit });
    }
    return [
      { extension: "mov", logicalBytes: 8_100_000_000, allocatedBytes: 8_100_003_840, fileCount: 1 },
      { extension: "app", logicalBytes: 6_300_000_000, allocatedBytes: 6_420_000_000, fileCount: 90 },
    ].slice(0, limit);
  },

  async revealItem(scanId: string, nodeId: number): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("reveal_item", { scan_id: scanId, node_id: nodeId });
    }
  },

  async openItem(scanId: string, nodeId: number): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("open_item", { scan_id: scanId, node_id: nodeId });
    }
  },

  async trashItem(scanId: string, nodeId: number): Promise<ScanInfo> {
    if (isTauriRuntime()) {
      return invoke<ScanInfo>("trash_item", { scan_id: scanId, node_id: nodeId });
    }
    return {
      scanId,
      status: "complete",
      stale: true,
      summary: null,
      errorMessage: null,
    };
  },
};
