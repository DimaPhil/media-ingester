# Media HTTP client

`MediaClient` validates every request and response against `@media-ingest/contracts`. Mutations first compare the deployed contract fingerprint, and redirects are rejected to avoid forwarding credentials. Remote URLs require HTTPS; loopback HTTP is supported for development.

```ts
import { MediaClient } from '@media-ingest/client';

const media = new MediaClient({
  baseUrl: process.env.MEDIA_API_URL!,
  token: process.env.MEDIA_API_TOKEN!,
});
const job = await media.call('submit', {
  request: {
    kind: 'transcription',
    source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
    provider: 'openai',
  },
});
const status = await media.call('get', { id: job.id });
```

For embedded processing without HTTP, use `@media-ingest/sdk` instead.
