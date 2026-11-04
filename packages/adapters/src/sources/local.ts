import { copyFile, stat } from 'node:fs/promises';
import { type NodeFiles, safeName } from '../files.js';
import type { SourceDriver } from './download.js';

export function localSource(files: NodeFiles): SourceDriver {
  return {
    async resolve(source, context) {
      if (source.kind === 'upload') {
        const metadata = await files.uploadMetadata(context.ownerId, source.uri);
        return { source, fileName: metadata.fileName, metadata: {} };
      }
      const info = await stat(source.uri);
      if (!info.isFile()) throw new Error('Local source must be a regular file');
      return { source, fileName: safeName(source.uri), metadata: { size: info.size } };
    },
    async download({ source }, context, { path, maxBytes }) {
      const origin =
        source.kind === 'upload'
          ? (await files.uploadMetadata(context.ownerId, source.uri)).path
          : source.uri;
      if ((await stat(origin)).size > maxBytes)
        throw new Error('Media exceeds configured download limit');
      await copyFile(origin, path);
      return path;
    },
  };
}
