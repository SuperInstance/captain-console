/**
 * captain-console — Casey's input worker.
 * POST /note {text, tag?}  → append to D1 ledger (the captain's stream)
 * GET  /notes?limit=N&tag= → recent notes
 * POST /say  {text, voice?}→ TTS via Workers AI + pincher cache (R2/KV/D1)
 * GET  /stats              → ledger counts
 * Auth: Authorization: Bearer <CAPTAIN_TOKEN secret> on all routes.
 */
export interface Env {
  DB: D1Database;
  CACHE: R2Bucket;
  INDEX: KVNamespace;
  AI: any;
  CAPTAIN_TOKEN: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${env.CAPTAIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    const path = url.pathname;

    if (path === '/note' && req.method === 'POST') {
      const { text, tag } = await req.json() as { text?: string; tag?: string };
      if (!text?.trim()) return json({ error: 'text required' }, 400);
      await env.DB.prepare('INSERT INTO notes (text, tag) VALUES (?1, ?2)').bind(text.slice(0, 4000), tag?.slice(0, 60) ?? null).run();
      return json({ ok: true, ts: Date.now() });
    }

    if (path === '/notes' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), 100);
      const tag = url.searchParams.get('tag');
      const rows = tag
        ? await env.DB.prepare('SELECT id, text, tag, created_at FROM notes WHERE tag = ?1 ORDER BY id DESC LIMIT ?2').bind(tag, limit).all()
        : await env.DB.prepare('SELECT id, text, tag, created_at FROM notes ORDER BY id DESC LIMIT ?1').bind(limit).all();
      return json({ notes: rows.results });
    }

    if (path === '/say' && req.method === 'POST') {
      const { text, voice } = await req.json() as { text?: string; voice?: string };
      if (!text?.trim()) return json({ error: 'text required' }, 400);
      const v = voice ?? 'thero';
      const hash = await sha256(`tts:${v}:${text}`);
      const hit = await env.CACHE.get(hash, { type: 'arrayBuffer' });
      if (hit) {
        ctx.waitUntil(env.DB.prepare('UPDATE tts_ledger SET hits = hits + 1 WHERE hash = ?1').bind(hash).run().catch(() => {}));
        return new Response(hit, { headers: { 'Content-Type': 'audio/mpeg', 'x-cache': 'HIT' } });
      }
      const result: any = await env.AI.run('@cf/deepgram/aura-2-en' as never, { text, voice: v } as never);
      let audio: ArrayBuffer;
      if (result instanceof ArrayBuffer) audio = result;
      else if (result && typeof result === 'object' && typeof result.getReader === 'function') audio = await new Response(result).arrayBuffer();
      else if (result instanceof Response) audio = await result.arrayBuffer();
      else if (result && typeof result === 'object' && result.audio instanceof ArrayBuffer) audio = result.audio;
      else if (typeof result === 'string') audio = Uint8Array.from(atob(result), c => c.charCodeAt(0)).buffer as ArrayBuffer;
      else throw new Error('unexpected tts shape: ' + Object.prototype.toString.call(result));
      ctx.waitUntil(Promise.all([
        env.CACHE.put(hash, audio, { httpMetadata: { contentType: 'audio/mpeg' } }),
        env.DB.prepare('INSERT OR IGNORE INTO tts_ledger (hash, kind, hits) VALUES (?1, ?2, 0)').bind(hash, `voice:${v}`).run().catch(() => {}),
      ]));
      return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'x-cache': 'MISS' } });
    }

    if (path === '/stats' && req.method === 'GET') {
      const notes = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>();
      const tts = await env.DB.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits FROM tts_ledger').first();
      return json({ service: 'captain-console', notes: notes?.n ?? 0, tts });
    }

    return json({ error: 'not found', routes: ['POST /note', 'GET /notes', 'POST /say', 'GET /stats'] }, 404);
  },
};
