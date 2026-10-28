import path from 'node:path';

export function uploadSessionRelativePath(uploadId: string): string {
  return path.posix.join('uploads', '.sessions', uploadId);
}

export function uploadPartRelativePath(uploadId: string, index: number): string {
  return path.posix.join(uploadSessionRelativePath(uploadId), 'parts', `${index}.part`);
}

export function uploadPartTemporaryRelativePath(uploadId: string, index: number, owner: string): string {
  return path.posix.join(uploadSessionRelativePath(uploadId), 'parts', `${index}.partial.${owner}`);
}

export function uploadAssemblyRelativePath(uploadId: string, owner: string): string {
  return path.posix.join(uploadSessionRelativePath(uploadId), `assembled.partial.${owner}`);
}
