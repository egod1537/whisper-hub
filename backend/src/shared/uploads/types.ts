import type { OutputFormat } from '../queue/types.js';

export const uploadStatuses = ['uploading', 'finalizing', 'completed', 'expired', 'aborted'] as const;
export type UploadStatus = (typeof uploadStatuses)[number];

export interface UploadSession {
  id: string;
  status: UploadStatus;
  displayFilename: string;
  totalSizeBytes: number;
  expectedSha256: string | null;
  computedSha256: string | null;
  language: string;
  formats: OutputFormat[];
  chunkSizeBytes: number;
  totalChunks: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  jobId: string | null;
  finalizeOwner: string | null;
  finalizeLeaseExpiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface UploadPart {
  uploadId: string;
  index: number;
  bytes: number;
  sha256: string;
  relativePath: string;
  storedAt: string;
}

export interface UploadStatusView {
  uploadId: string;
  status: UploadStatus;
  sizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  receivedParts: number[];
  receivedBytes: number;
  expiresAt: string;
  jobId: string | null;
  error: { code: string; message: string } | null;
}
