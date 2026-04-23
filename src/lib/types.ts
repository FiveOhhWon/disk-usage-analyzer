export type NodeKind = "file" | "directory" | "symlink" | "other";

export type SortBy = "name" | "logicalBytes" | "allocatedBytes" | "kind";
export type SortDirection = "asc" | "desc";

export interface SortSpec {
  by: SortBy;
  direction: SortDirection;
}

export interface ScanOptions {
  includeHidden: boolean;
  stayOnFilesystem: boolean;
  followSymlinks: boolean;
  computeAllocated: boolean;
}

export interface ScanSummary {
  root: string;
  totalLogicalBytes: number;
  totalAllocatedBytes: number | null;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  errorCount: number;
  cancelled: boolean;
}

export interface NodeRow {
  id: number;
  name: string;
  path: string;
  kind: NodeKind;
  logicalBytes: number;
  allocatedBytes: number | null;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  childCount: number;
  percentOfRoot: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ExtensionRow {
  extension: string;
  logicalBytes: number;
  allocatedBytes: number | null;
  fileCount: number;
}

export interface VolumeInfo {
  name: string;
  mountPoint: string;
  fileSystem: string;
  totalBytes: number;
  availableBytes: number;
  isRemovable: boolean;
}

export interface ScanHandle {
  scanId: string;
}

export type ScanStatus = "running" | "complete" | "cancelled" | "failed";

export interface ScanInfo {
  scanId: string;
  status: ScanStatus;
  stale: boolean;
  summary: ScanSummary | null;
  errorMessage: string | null;
}

export type TopKind = "files" | "directories";

export type ScanEvent =
  | { type: "started"; root: string }
  | {
      type: "progress";
      entriesScanned: number;
      bytesScanned: number;
      currentPath: string;
    }
  | { type: "error"; path: string; message: string }
  | { type: "completed"; summary: ScanSummary }
  | { type: "cancelled"; summary: ScanSummary };

export interface AppSettings {
  recentRoots: string[];
  favoriteRoots: string[];
}

export interface FlatRow {
  row: NodeRow;
  depth: number;
}
